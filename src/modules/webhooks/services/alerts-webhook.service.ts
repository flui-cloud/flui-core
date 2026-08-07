import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { timingSafeEqual } from 'node:crypto';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ApplicationTrafficService } from '../../observability/services/application-traffic.service';
import {
  AlertEventsService,
  AlertTransition,
  IncomingAlert,
} from '../../observability/services/alert-events.service';
import { UserEventsGateway } from '../../auth/gateway/user-events.gateway';
import {
  AlertmanagerAlertDto,
  AlertmanagerWebhookDto,
  AlertsWebhookResultDto,
} from '../dto/alertmanager-webhook.dto';

interface ResolvedSubject {
  applicationId?: string;
  applicationSlug?: string;
  namespace?: string;
  node?: string;
}

/**
 * Everything the batch needs to attribute its alerts, loaded up front. Scoped to one
 * request rather than held on the service: concurrent webhooks would otherwise share
 * — and indefinitely grow — the same maps.
 */
interface ResolutionContext {
  byNamespaceSlug: Map<string, ApplicationEntity>;
  bySlug: Map<string, ApplicationEntity>;
  byTraefikService: Map<string, ApplicationEntity>;
  owners: Map<string, string>;
}

/**
 * Receives Alertmanager notifications.
 *
 * Alertmanager owns grouping, deduplication, silences and inhibition; it knows nothing
 * about Flui projects or RBAC, so it delivers everything here and Flui resolves the
 * subject. This is the seam where tenant-aware delivery plugs in — today it resolves
 * and records, it does not yet notify anyone.
 */
@Injectable()
export class AlertsWebhookService {
  private readonly logger = new Logger(AlertsWebhookService.name);

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(ApplicationEntity)
    private readonly applications: Repository<ApplicationEntity>,
    private readonly traffic: ApplicationTrafficService,
    private readonly alertEvents: AlertEventsService,
    private readonly userEvents: UserEventsGateway,
  ) {}

  async handle(
    credentials: { header?: string; authorization?: string },
    dto: AlertmanagerWebhookDto,
  ): Promise<AlertsWebhookResultDto> {
    this.assertToken(this.extractToken(credentials));

    const alerts = dto.alerts ?? [];
    if (alerts.length === 0) {
      return { received: true, alerts: 0, resolved: 0 };
    }

    // Resolution context is built once for the whole batch. A node going down fires
    // one alert per application on it, and resolving each one independently meant a
    // full application table load per alert.
    const context = await this.buildResolutionContext(alerts);

    let resolvedCount = 0;
    const incoming: IncomingAlert[] = [];

    for (const alert of alerts) {
      const subject = this.resolveSubject(alert, context);
      if (subject.applicationId) resolvedCount++;

      const name = alert.labels?.alertname ?? 'unknown';
      const severity = alert.labels?.severity ?? 'unknown';
      const target =
        subject.applicationSlug ??
        subject.node ??
        this.describeUnresolved(alert);

      const line = `[alert] ${alert.status} ${severity} ${name} → ${target}`;
      if (alert.status === 'firing' && severity === 'critical') {
        this.logger.error(line);
      } else if (alert.status === 'firing') {
        this.logger.warn(line);
      } else {
        this.logger.log(line);
      }

      incoming.push(this.toIncoming(alert, subject, name, severity));
    }

    const transitions = await this.alertEvents.record(incoming);
    this.announce(transitions, context);

    return { received: true, alerts: alerts.length, resolved: resolvedCount };
  }

  /**
   * A transition is what a human would call news: it started, or it recovered. The
   * repeats in between update the row and tell nobody.
   *
   * This is the seam the notification substrate plugs into — the dashboard bell first,
   * then user webhooks and ntfy, routed by severity.
   */
  private announce(
    transitions: AlertTransition[],
    context: ResolutionContext,
  ): void {
    for (const { kind, event } of transitions) {
      const userId = event.applicationId
        ? context.owners.get(event.applicationId)
        : undefined;
      if (!userId) continue;
      this.userEvents.emitAlert(userId, {
        id: event.id,
        kind,
        alertname: event.alertname,
        severity: event.severity,
        summary: event.annotations?.summary ?? event.alertname,
        applicationId: event.applicationId ?? null,
        applicationSlug: event.applicationSlug ?? null,
        startsAt: event.startsAt.toISOString(),
      });
    }
  }

  private toIncoming(
    alert: AlertmanagerAlertDto,
    subject: ResolvedSubject,
    alertname: string,
    severity: string,
  ): IncomingAlert {
    const labels = alert.labels ?? {};
    return {
      fingerprint: alert.fingerprint,
      status: alert.status === 'resolved' ? 'resolved' : 'firing',
      startsAt: new Date(alert.startsAt),
      endsAt: this.parseEndsAt(alert.endsAt),
      alertname,
      severity,
      fluiKind: labels.flui_kind ?? null,
      clusterId: labels.cluster_id ?? null,
      applicationId: subject.applicationId ?? null,
      applicationSlug: subject.applicationSlug ?? null,
      namespace: subject.namespace ?? null,
      nodeInstance: subject.node ?? null,
      labels,
      annotations: alert.annotations ?? {},
    };
  }

  /**
   * Alertmanager sends a zero time (`0001-01-01T00:00:00Z`) for an alert that has not
   * ended; storing it would date the incident to the year 1.
   */
  private parseEndsAt(value?: string): Date | null {
    if (!value) return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.getUTCFullYear() < 2000 ? null : parsed;
  }

  /**
   * Flui webhooks carry `X-Flui-Token`, but Alertmanager cannot set arbitrary headers on
   * a webhook receiver — its http_config only offers standard auth. Both are accepted so
   * the endpoint matches the platform convention and still works with a stock sender.
   */
  private extractToken(credentials: {
    header?: string;
    authorization?: string;
  }): string | undefined {
    if (credentials.header) return credentials.header;
    const auth = credentials.authorization;
    if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
    return undefined;
  }

  /**
   * Fail closed. An unset token would otherwise leave a public, unauthenticated endpoint
   * that accepts arbitrary alert payloads — the API is reachable through the ingress,
   * even though Alertmanager itself only talks to it in-cluster.
   */
  private assertToken(token: string | undefined): void {
    const expected = this.config.get<string>('ALERTS_WEBHOOK_TOKEN');
    if (!expected) {
      this.logger.error(
        'ALERTS_WEBHOOK_TOKEN is not configured — rejecting alert webhook',
      );
      throw new UnauthorizedException('Alert webhook is not configured');
    }
    if (!token || !this.constantTimeEquals(token, expected)) {
      throw new UnauthorizedException('Invalid alert webhook token');
    }
  }

  private constantTimeEquals(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
  }

  /**
   * Alerts carry `flui_kind` so the subject can be resolved without guessing from the
   * alert name. Application alerts key off the Kubernetes label, which is the slug;
   * traffic alerts key off the Traefik service id.
   */
  private resolveSubject(
    alert: AlertmanagerAlertDto,
    context: ResolutionContext,
  ): ResolvedSubject {
    const labels = alert.labels ?? {};

    switch (labels.flui_kind) {
      case 'application':
        return this.resolveBySlug(
          context,
          labels.label_app_kubernetes_io_name,
          labels.namespace,
        );
      case 'traffic':
        return this.resolveByTraefikService(context, labels.service);
      case 'node':
        return { node: labels.instance };
      default:
        return {};
    }
  }

  /**
   * Loads everything the batch needs in two queries, then resolves in memory.
   *
   * The traffic map needs every candidate because a Traefik service id cannot be
   * reversed into a lookup, only reconstructed forward. It is narrowed by cluster
   * where the alert says which one. The durable fix is to persist the service id on
   * the application row and index it — this keeps it to once per batch instead of
   * once per alert, which is what actually hurt.
   */
  private async buildResolutionContext(
    alerts: AlertmanagerAlertDto[],
  ): Promise<ResolutionContext> {
    const kinds = new Set(alerts.map((a) => a.labels?.flui_kind));
    const context: ResolutionContext = {
      byNamespaceSlug: new Map(),
      bySlug: new Map(),
      byTraefikService: new Map(),
      owners: new Map(),
    };

    if (kinds.has('application')) {
      await this.loadApplicationSubjects(alerts, context);
    }
    if (kinds.has('traffic')) {
      await this.loadTrafficSubjects(alerts, context);
    }

    return context;
  }

  private async loadApplicationSubjects(
    alerts: AlertmanagerAlertDto[],
    context: ResolutionContext,
  ): Promise<void> {
    const slugs = this.distinct(
      alerts,
      'application',
      (labels) => labels.label_app_kubernetes_io_name,
    );
    if (slugs.length === 0) return;

    const apps = await this.applications.find({
      select: ['id', 'slug', 'k8sNamespace', 'userId'],
      where: { slug: In(slugs) },
    });
    for (const app of apps) {
      context.byNamespaceSlug.set(`${app.k8sNamespace}/${app.slug}`, app);
      context.bySlug.set(app.slug, app);
      this.rememberOwner(context, app);
    }
  }

  private async loadTrafficSubjects(
    alerts: AlertmanagerAlertDto[],
    context: ResolutionContext,
  ): Promise<void> {
    const clusterIds = this.distinct(
      alerts,
      'traffic',
      (labels) => labels.cluster_id,
    );
    const candidates = await this.applications.find({
      select: ['id', 'slug', 'k8sNamespace', 'port', 'portProtocol', 'userId'],
      ...(clusterIds.length > 0
        ? { where: { clusterId: In(clusterIds) } }
        : {}),
    });

    for (const app of candidates) {
      const id = this.traffic.buildTraefikServiceId({
        slug: app.slug,
        namespace: app.k8sNamespace,
        port: app.port,
        portProtocol: app.portProtocol,
      });
      if (!id) continue;
      context.byTraefikService.set(id, app);
      this.rememberOwner(context, app);
    }
  }

  private distinct(
    alerts: AlertmanagerAlertDto[],
    kind: string,
    pick: (labels: Record<string, string>) => string | undefined,
  ): string[] {
    const values = alerts
      .filter((a) => a.labels?.flui_kind === kind)
      .map((a) => pick(a.labels ?? {}))
      .filter((value): value is string => Boolean(value));
    return [...new Set(values)];
  }

  private rememberOwner(
    context: ResolutionContext,
    app: ApplicationEntity,
  ): void {
    if (app.userId) context.owners.set(app.id, app.userId);
  }

  /**
   * Namespace first, slug alone as a fallback.
   *
   * The fallback is only sound because `applications.slug` carries a global UNIQUE
   * constraint, so a slug cannot name two applications — if that ever becomes
   * per-tenant, this must become namespace-only or alerts will be attributed, and
   * notified, to whichever row came back first.
   */
  private resolveBySlug(
    context: ResolutionContext,
    slug?: string,
    namespace?: string,
  ): ResolvedSubject {
    if (!slug) return {};
    const app =
      (namespace
        ? context.byNamespaceSlug.get(`${namespace}/${slug}`)
        : undefined) ?? context.bySlug.get(slug);
    if (!app) return { applicationSlug: slug, namespace };
    return {
      applicationId: app.id,
      applicationSlug: app.slug,
      namespace: app.k8sNamespace,
    };
  }

  /**
   * Matched by rebuilding each candidate's service id rather than parsing the label.
   * The label is `<namespace>-<slug>-svc-<port>@kubernetes` and namespaces contain
   * dashes, so parsing it back is ambiguous; constructing forward is exact.
   */
  private resolveByTraefikService(
    context: ResolutionContext,
    service?: string,
  ): ResolvedSubject {
    if (!service) return {};
    const app = context.byTraefikService.get(service);
    if (!app) return {};
    return {
      applicationId: app.id,
      applicationSlug: app.slug,
      namespace: app.k8sNamespace,
    };
  }

  private describeUnresolved(alert: AlertmanagerAlertDto): string {
    const labels = alert.labels ?? {};
    return (
      labels.service ??
      labels.instance ??
      labels.label_app_kubernetes_io_name ??
      'unresolved'
    );
  }
}
