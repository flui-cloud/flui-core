import { Injectable, Logger } from '@nestjs/common';
import { PrometheusQueryService } from './prometheus-query.service';
import { PrometheusQueryResult } from '../interfaces/prometheus-response.interface';
import {
  ApplicationTrafficDto,
  TrafficHistoryPointDto,
  TrafficLatencyDto,
  TrafficMethodBreakdownDto,
  TrafficStatusCodeBreakdownDto,
  TrafficStatusDto,
} from '../dto/application-traffic.dto';

export interface TrafficTarget {
  slug: string;
  namespace: string;
  port?: number;
  portProtocol?: 'http' | 'tcp';
}

/**
 * Application Traffic Service
 *
 * Reads edge (Traefik) HTTP metrics for Flui-managed applications.
 *
 * Traefik exposes per-service counters whose `service` label is derived from the
 * Ingress backend, not from anything Flui declares. For an application deployed by
 * Flui the Service is always `{slug}-svc` in `{namespace}` on `{port}`, so the label
 * is reconstructed exactly rather than matched by regex — namespaces contain dashes
 * (`user-dawit`), which makes a parsing approach ambiguous.
 */
@Injectable()
export class ApplicationTrafficService {
  private readonly logger = new Logger(ApplicationTrafficService.name);

  /**
   * Below this many histogram boundaries, percentile interpolation says more about
   * the bucket layout than about the application. Traefik defaults to four.
   */
  private static readonly COARSE_BUCKET_THRESHOLD = 6;

  constructor(private readonly prometheus: PrometheusQueryService) {}

  buildTraefikServiceId(target: TrafficTarget): string | null {
    if (!this.isRoutable(target)) {
      return null;
    }
    return `${target.namespace}-${target.slug}-svc-${target.port}@kubernetes`;
  }

  /**
   * Every name Traefik gives the routes that reach this application: an
   * application's own Ingress (`-svc-<port>`), a platform component's Ingress
   * (`-<port>`) and an IngressRoute (`-<hash>@kubernetescrd`). Requests are
   * counted across all of them; reading only the first left the API showing
   * no traffic under load.
   */
  traefikServicePattern(target: TrafficTarget): string | null {
    if (!this.isRoutable(target)) return null;
    const ns = escapeRegex(target.namespace);
    const slug = escapeRegex(target.slug);
    return `${ns}-${slug}-(svc-)?${target.port}@kubernetes|${ns}-${slug}-[0-9a-f]+@kubernetescrd`;
  }

  /** Whether a Traefik service label names one of this application's routes. */
  servesTraefikService(target: TrafficTarget, service: string): boolean {
    const pattern = this.traefikServicePattern(target);
    return pattern !== null && new RegExp(`^(?:${pattern})$`).test(service);
  }

  isRoutable(target: TrafficTarget): boolean {
    return Boolean(target.port) && target.portProtocol !== 'tcp';
  }

  async getTrafficInstant(
    target: TrafficTarget,
    window: string,
  ): Promise<ApplicationTrafficDto> {
    const serviceId = this.buildTraefikServiceId(target);
    if (!serviceId) {
      return this.emptyTraffic();
    }

    const selector = this.selector(target);

    const [
      byCodeResult,
      byMethodResult,
      meanResult,
      bucketsResult,
      p50Result,
      p90Result,
      p95Result,
      p99Result,
    ] = await Promise.all([
      this.instant(
        routed(
          (requests) =>
            `sum by (code) (rate(${requests}${selector}[${window}]))`,
        ),
      ),
      this.instant(
        routed(
          (requests) =>
            `sum by (method) (rate(${requests}${selector}[${window}]))`,
        ),
      ),
      this.instant(
        routed(
          (_, duration) =>
            `sum(rate(${duration}_sum${timed(selector)}[${window}])) / ` +
            `sum(rate(${duration}_count${timed(selector)}[${window}]))`,
        ),
      ),
      this.instant(
        routed(
          (_, duration) =>
            `count by (le) (${duration}_bucket${timed(selector)})`,
        ),
      ),
      this.quantile(0.5, selector, window),
      this.quantile(0.9, selector, window),
      this.quantile(0.95, selector, window),
      this.quantile(0.99, selector, window),
    ]);

    const byCode = this.toLabelledValues(byCodeResult, 'code');
    const byMethod = this.toLabelledValues(byMethodResult, 'method');
    const totalRate = byCode.reduce((sum, entry) => sum + entry.value, 0);
    const boundaries = this.bucketBoundaries(bucketsResult);

    return {
      rate: {
        requests_per_second: this.round(totalRate, 4),
        requests_in_window: this.round(
          totalRate * this.windowSeconds(window),
          0,
        ),
      },
      status: this.buildStatus(byCode, totalRate),
      latency: this.buildLatency(
        {
          p50: this.scalar(p50Result),
          p90: this.scalar(p90Result),
          p95: this.scalar(p95Result),
          p99: this.scalar(p99Result),
          mean: this.scalar(meanResult),
        },
        boundaries,
      ),
      by_method: byMethod
        .map<TrafficMethodBreakdownDto>((entry) => ({
          method: entry.label,
          requests_per_second: this.round(entry.value, 4),
        }))
        .sort(
          (a, b) => (b.requests_per_second ?? 0) - (a.requests_per_second ?? 0),
        ),
      by_status_code: byCode
        .map<TrafficStatusCodeBreakdownDto>((entry) => ({
          code: entry.label,
          requests_per_second: this.round(entry.value, 4),
        }))
        .sort(
          (a, b) => (b.requests_per_second ?? 0) - (a.requests_per_second ?? 0),
        ),
    };
  }

  async getTrafficHistory(
    target: TrafficTarget,
    startUnix: number,
    endUnix: number,
    step: string,
    window: string,
  ): Promise<TrafficHistoryPointDto[]> {
    const serviceId = this.buildTraefikServiceId(target);
    if (!serviceId) {
      return [];
    }

    const selector = this.selector(target);

    const [totalSeries, clientErrorSeries, serverErrorSeries, p95Series] =
      await Promise.all([
        this.range(
          routed((requests) => `sum(rate(${requests}${selector}[${window}]))`),
          startUnix,
          endUnix,
          step,
        ),
        this.range(
          routed(
            (requests) =>
              `sum(rate(${requests}${this.selector(target, 'code=~"4.."')}[${window}]))`,
          ),
          startUnix,
          endUnix,
          step,
        ),
        this.range(
          routed(
            (requests) =>
              `sum(rate(${requests}${this.selector(target, 'code=~"5.."')}[${window}]))`,
          ),
          startUnix,
          endUnix,
          step,
        ),
        this.range(
          routed(
            (_, duration) =>
              `histogram_quantile(0.95, sum by (le) (rate(${duration}_bucket${timed(selector)}[${window}])))`,
          ),
          startUnix,
          endUnix,
          step,
        ),
      ]);

    const total = this.toSeriesMap(totalSeries);
    const clientErrors = this.toSeriesMap(clientErrorSeries);
    const serverErrors = this.toSeriesMap(serverErrorSeries);
    const p95 = this.toSeriesMap(p95Series);

    const timestamps = new Set<number>([
      ...total.keys(),
      ...clientErrors.keys(),
      ...serverErrors.keys(),
      ...p95.keys(),
    ]);

    return Array.from(timestamps)
      .sort((a, b) => a - b)
      .map<TrafficHistoryPointDto>((ts) => ({
        timestamp: new Date(ts * 1000).toISOString(),
        requests_per_second: this.round(total.get(ts), 4),
        rate_4xx: this.round(clientErrors.get(ts), 4),
        rate_5xx: this.round(serverErrors.get(ts), 4),
        p95_seconds: this.round(p95.get(ts), 4),
      }));
  }

  /**
   * Cluster-wide summary. Issues three aggregate queries instead of N per application,
   * then attributes the rows back to applications by their reconstructed service id.
   */
  /**
   * One application's figures from the per-service summary, across every
   * route that reaches it. Requests and errors add up; the p95 shown is the
   * slowest route's, which is never better than the truth.
   */
  summaryFor(
    target: TrafficTarget,
    byService: Map<
      string,
      { rps: number; serverErrorPercent: number | null; p95: number | null }
    >,
  ):
    | { rps: number; serverErrorPercent: number | null; p95: number | null }
    | undefined {
    const matched = [...byService].filter(([service]) =>
      this.servesTraefikService(target, service),
    );
    if (matched.length === 0) return undefined;
    let rps = 0;
    let errors = 0;
    let p95: number | null = null;
    for (const [, s] of matched) {
      rps += s.rps;
      errors += ((s.serverErrorPercent ?? 0) / 100) * s.rps;
      if (s.p95 !== null) p95 = p95 === null ? s.p95 : Math.max(p95, s.p95);
    }
    return {
      rps,
      serverErrorPercent: rps > 0 ? this.round((errors / rps) * 100, 2) : null,
      p95,
    };
  }

  async getClusterTrafficByService(
    window: string,
  ): Promise<
    Map<
      string,
      { rps: number; serverErrorPercent: number | null; p95: number | null }
    >
  > {
    const [totalResult, serverErrorResult, p95Result] = await Promise.all([
      this.instant(
        routed((requests) => `sum by (service) (rate(${requests}[${window}]))`),
      ),
      this.instant(
        routed(
          (requests) =>
            `sum by (service) (rate(${requests}{code=~"5.."}[${window}]))`,
        ),
      ),
      this.instant(
        routed(
          (_, duration) =>
            `histogram_quantile(0.95, sum by (service, le) (rate(${duration}_bucket${timed('')}[${window}])))`,
        ),
      ),
    ]);

    const totals = this.toLabelledValues(totalResult, 'service');
    const serverErrors = new Map(
      this.toLabelledValues(serverErrorResult, 'service').map((entry) => [
        entry.label,
        entry.value,
      ]),
    );
    const p95s = new Map(
      this.toLabelledValues(p95Result, 'service').map((entry) => [
        entry.label,
        entry.value,
      ]),
    );

    const summary = new Map<
      string,
      { rps: number; serverErrorPercent: number | null; p95: number | null }
    >();

    for (const entry of totals) {
      const errors = serverErrors.get(entry.label) ?? 0;
      summary.set(entry.label, {
        rps: entry.value,
        serverErrorPercent:
          entry.value > 0 ? this.round((errors / entry.value) * 100, 2) : null,
        p95: this.round(p95s.get(entry.label), 4),
      });
    }

    return summary;
  }

  // =====================================================
  // Internals
  // =====================================================

  private selector(target: TrafficTarget, extra?: string): string {
    const escaped = (this.traefikServicePattern(target) ?? '')
      .replaceAll('\\', String.raw`\\`)
      .replaceAll('"', String.raw`\"`);
    const matchers = [`service=~"${escaped}"`];
    if (extra) {
      matchers.push(extra);
    }
    return `{${matchers.join(',')}}`;
  }

  private quantile(q: number, selector: string, window: string) {
    return this.instant(
      routed(
        (_, duration) =>
          `histogram_quantile(${q}, sum by (le) (rate(${duration}_bucket${timed(selector)}[${window}])))`,
      ),
    );
  }

  private async instant(query: string): Promise<PrometheusQueryResult[]> {
    try {
      const response = await this.prometheus.queryInstant(query);
      return response.data?.result ?? [];
    } catch (error) {
      this.logger.warn(
        `Traffic query failed, returning empty: ${error.message}`,
      );
      return [];
    }
  }

  private async range(
    query: string,
    start: number,
    end: number,
    step: string,
  ): Promise<PrometheusQueryResult[]> {
    try {
      const response = await this.prometheus.queryRange(
        query,
        start,
        end,
        step,
      );
      return response.data?.result ?? [];
    } catch (error) {
      this.logger.warn(
        `Traffic range query failed, returning empty: ${error.message}`,
      );
      return [];
    }
  }

  private buildStatus(
    byCode: Array<{ label: string; value: number }>,
    totalRate: number,
  ): TrafficStatusDto {
    const classRate = (prefix: string) =>
      byCode
        .filter((entry) => this.statusClass(entry.label) === prefix)
        .reduce((sum, entry) => sum + entry.value, 0);

    const rate4xx = classRate('4');
    const rate5xx = classRate('5');

    return {
      rate_2xx: this.round(classRate('2'), 4),
      rate_3xx: this.round(classRate('3'), 4),
      rate_4xx: this.round(rate4xx, 4),
      rate_5xx: this.round(rate5xx, 4),
      server_error_percent:
        totalRate > 0 ? this.round((rate5xx / totalRate) * 100, 2) : null,
      client_error_percent:
        totalRate > 0 ? this.round((rate4xx / totalRate) * 100, 2) : null,
    };
  }

  /**
   * Traefik also records non-HTTP outcomes on this counter — gRPC status codes and `0`
   * for aborted websocket upgrades — so only three-digit 1xx-5xx values are treated as
   * HTTP classes. Everything else stays visible in the per-code breakdown but is kept
   * out of the error percentages, where it would otherwise read as a server fault.
   */
  private statusClass(code: string): string | null {
    if (!/^[1-5]\d{2}$/.test(code)) {
      return null;
    }
    return code[0];
  }

  private buildLatency(
    quantiles: {
      p50: number | null;
      p90: number | null;
      p95: number | null;
      p99: number | null;
      mean: number | null;
    },
    boundaries: number[],
  ): TrafficLatencyDto {
    return {
      p50_seconds: this.round(quantiles.p50, 4),
      p90_seconds: this.round(quantiles.p90, 4),
      p95_seconds: this.round(quantiles.p95, 4),
      p99_seconds: this.round(quantiles.p99, 4),
      mean_seconds: this.round(quantiles.mean, 4),
      estimates_are_coarse:
        boundaries.length > 0 &&
        boundaries.length < ApplicationTrafficService.COARSE_BUCKET_THRESHOLD,
      bucket_boundaries_seconds: boundaries,
    };
  }

  private bucketBoundaries(results: PrometheusQueryResult[]): number[] {
    return results
      .map((result) => Number(result.metric.le))
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => a - b);
  }

  private toLabelledValues(
    results: PrometheusQueryResult[],
    label: string,
  ): Array<{ label: string; value: number }> {
    return results
      .map((result) => ({
        label: result.metric[label] ?? 'unknown',
        value: Number(result.value?.[1]),
      }))
      .filter((entry) => Number.isFinite(entry.value));
  }

  private toSeriesMap(results: PrometheusQueryResult[]): Map<number, number> {
    const map = new Map<number, number>();
    for (const result of results) {
      for (const [timestamp, raw] of result.values ?? []) {
        const value = Number(raw);
        if (Number.isFinite(value)) {
          map.set(timestamp, value);
        }
      }
    }
    return map;
  }

  private scalar(results: PrometheusQueryResult[]): number | null {
    const value = Number(results[0]?.value?.[1]);
    return Number.isFinite(value) ? value : null;
  }

  private windowSeconds(window: string): number {
    const match = /^(\d+)([smhd])$/.exec(window);
    if (!match) {
      return 300;
    }
    const amount = Number(match[1]);
    const unit = match[2];
    const multipliers: Record<string, number> = {
      s: 1,
      m: 60,
      h: 3600,
      d: 86400,
    };
    return amount * (multipliers[unit] ?? 60);
  }

  private round(
    value: number | null | undefined,
    decimals: number,
  ): number | null {
    if (value === null || value === undefined || !Number.isFinite(value)) {
      return null;
    }
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
  }

  private emptyTraffic(): ApplicationTrafficDto {
    return {
      rate: { requests_per_second: null, requests_in_window: null },
      status: {
        rate_2xx: null,
        rate_3xx: null,
        rate_4xx: null,
        rate_5xx: null,
        server_error_percent: null,
        client_error_percent: null,
      },
      latency: {
        p50_seconds: null,
        p90_seconds: null,
        p95_seconds: null,
        p99_seconds: null,
        mean_seconds: null,
        estimates_are_coarse: false,
        bucket_boundaries_seconds: [],
      },
      by_method: [],
      by_status_code: [],
    };
  }
}

const escapeRegex = (value: string): string =>
  value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

const ROUTER = {
  requests: 'traefik_router_requests_total',
  duration: 'traefik_router_request_duration_seconds',
};
const SERVICE = {
  requests: 'traefik_service_requests_total',
  duration: 'traefik_service_request_duration_seconds',
};

/**
 * A websocket or an event stream is timed for as long as it stays open, often
 * minutes: counted as requests, but kept out of every latency figure.
 */
export function timed(selector: string): string {
  const matcher = 'protocol!~"websocket|sse"';
  return selector ? selector.replace(/}$/, `,${matcher}}`) : `{${matcher}}`;
}

/**
 * The router's counters where Traefik keeps them, the service's otherwise.
 * Only the router's count what Traefik answers by itself, such as the 503 an
 * application gets while no copy of it is ready; an installation whose
 * Traefik predates `addRoutersLabels` has the service's alone.
 */
export function routed(
  build: (requests: string, duration: string) => string,
): string {
  return `(${build(ROUTER.requests, ROUTER.duration)}) or (${build(SERVICE.requests, SERVICE.duration)})`;
}
