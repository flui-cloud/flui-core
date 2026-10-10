import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { PrometheusQueryService } from '../../observability/services/prometheus-query.service';
import {
  FLUI_REGISTRY_CONFIG,
  FLUI_REGISTRY_NAME,
  FLUI_REGISTRY_NAMESPACE,
  FluiRegistryConfig,
} from '../flui-registry.config';

export const REGISTRY_TRAFFIC_WINDOWS = ['1h', '24h', '7d', '30d'] as const;
export type RegistryTrafficWindow = (typeof REGISTRY_TRAFFIC_WINDOWS)[number];

export interface RegistryTraffic {
  window: RegistryTrafficWindow;
  requests: {
    /** Reads: manifests and layers fetched or checked. */
    pulls: number;
    /** Uploads: layers and manifests written. */
    pushes: number;
    deletes: number;
  };
  outcomes: {
    ok: number;
    /** Over quota, too large, or over the rate limit. */
    refused: number;
    notFound: number;
    failed: number;
  };
  bytesIn: number;
  bytesOut: number;
  /** Busiest five minutes of the window, in bytes per second. */
  peakBytesPerSecondIn: number;
  peakBytesPerSecondOut: number;
  /** On a bucket every byte served is first read from it: what its provider may bill as egress. */
  readFromBucketBytes: number | null;
}

/**
 * MetricsQL, not PromQL: `increase` ignores a series that first appears already
 * counting, which is exactly a sudden burst of a new status code;
 * `increase_pure` counts it from zero.
 */
const INCREASE = 'increase_pure';

/**
 * Traefik names the registry's route after the namespace, the route and a hash.
 * Requests are counted on the router where Traefik keeps it: only there are the
 * 503s it answers itself, while no copy of the registry is ready.
 */
const SERVICE = `service=~"${FLUI_REGISTRY_NAMESPACE}-${FLUI_REGISTRY_NAME}-.*@kubernetescrd"`;

/**
 * What the instance registry carried, read from the counters of the router
 * every push and pull goes through. A 401 is not counted as refused: every
 * client gets one before it asks for its token.
 */
@Injectable()
export class RegistryTrafficService {
  constructor(
    @Inject(FLUI_REGISTRY_CONFIG) private readonly config: FluiRegistryConfig,
    private readonly prometheus: PrometheusQueryService,
  ) {}

  async traffic(window: string = '24h'): Promise<RegistryTraffic> {
    if (!REGISTRY_TRAFFIC_WINDOWS.includes(window as RegistryTrafficWindow)) {
      throw new BadRequestException(
        `window must be one of ${REGISTRY_TRAFFIC_WINDOWS.join(', ')}`,
      );
    }
    const w = window as RegistryTrafficWindow;
    const counted = (by: string) =>
      `(sum by (${by}) (${INCREASE}(traefik_router_requests_total{${SERVICE}}[${w}]))) or (sum by (${by}) (${INCREASE}(traefik_service_requests_total{${SERVICE}}[${w}])))`;
    const [byMethod, byCode, bytesIn, bytesOut, peakIn, peakOut] =
      await Promise.all([
        this.vector(counted('method'), 'method'),
        this.vector(counted('code'), 'code'),
        this.scalar(
          `sum(${INCREASE}(traefik_service_requests_bytes_total{${SERVICE}}[${w}]))`,
        ),
        this.scalar(
          `sum(${INCREASE}(traefik_service_responses_bytes_total{${SERVICE}}[${w}]))`,
        ),
        this.scalar(
          `max_over_time(sum(rate(traefik_service_requests_bytes_total{${SERVICE}}[5m]))[${w}:5m])`,
        ),
        this.scalar(
          `max_over_time(sum(rate(traefik_service_responses_bytes_total{${SERVICE}}[5m]))[${w}:5m])`,
        ),
      ]);

    const sumOf = (from: Map<string, number>, keys: (k: string) => boolean) =>
      Math.round(
        [...from].filter(([k]) => keys(k)).reduce((t, [, v]) => t + v, 0),
      );
    const out = Math.round(bytesOut);
    return {
      window: w,
      requests: {
        pulls: sumOf(byMethod, (m) => m === 'GET' || m === 'HEAD'),
        pushes: sumOf(byMethod, (m) => ['POST', 'PUT', 'PATCH'].includes(m)),
        deletes: sumOf(byMethod, (m) => m === 'DELETE'),
      },
      outcomes: {
        ok: sumOf(byCode, (c) => /^[23]/.test(c)),
        refused: sumOf(byCode, (c) => ['403', '413', '429'].includes(c)),
        notFound: sumOf(byCode, (c) => c === '404'),
        failed: sumOf(byCode, (c) => c.startsWith('5')),
      },
      bytesIn: Math.round(bytesIn),
      bytesOut: out,
      peakBytesPerSecondIn: Math.round(peakIn),
      peakBytesPerSecondOut: Math.round(peakOut),
      readFromBucketBytes: this.config.storageBackend === 's3' ? out : null,
    };
  }

  private async vector(
    query: string,
    label: string,
  ): Promise<Map<string, number>> {
    const response = await this.prometheus.queryInstant(query);
    const values = new Map<string, number>();
    for (const series of response.data?.result ?? []) {
      const key = series.metric?.[label] ?? '';
      const value = Number(series.value?.[1]);
      if (Number.isFinite(value)) {
        values.set(key, (values.get(key) ?? 0) + value);
      }
    }
    return values;
  }

  private async scalar(query: string): Promise<number> {
    const response = await this.prometheus.queryInstant(query);
    const value = Number(response.data?.result?.[0]?.value?.[1]);
    return Number.isFinite(value) ? value : 0;
  }
}
