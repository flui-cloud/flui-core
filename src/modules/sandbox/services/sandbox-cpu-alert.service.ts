import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AlertEventsService } from '../../observability/services/alert-events.service';
import { AlertMailService } from '../../observability/services/alert-mail.service';
import { PrometheusQueryService } from '../../observability/services/prometheus-query.service';
import {
  SandboxTenantEntity,
  SandboxTenantState,
} from '../entities/sandbox-tenant.entity';
import { SANDBOX_CONFIG, SandboxConfig } from '../sandbox.config';

interface Hot {
  namespace: string;
  app: string;
  percent: number;
}

/**
 * Tells the operator when a guest application has run at its CPU limit for a
 * while. The ceiling already stops one area from taking the node; this is for
 * the person who has to decide whether it is a build or a miner, and who to
 * block if it is the second.
 */
@Injectable()
export class SandboxCpuAlertService {
  static readonly ALERTNAME = 'FluiSandboxCpuAtLimit';
  private readonly logger = new Logger(SandboxCpuAlertService.name);

  constructor(
    @InjectRepository(SandboxTenantEntity)
    private readonly tenants: Repository<SandboxTenantEntity>,
    private readonly prometheus: PrometheusQueryService,
    private readonly alerts: AlertEventsService,
    private readonly mail: AlertMailService,
    @Inject(SANDBOX_CONFIG) private readonly config: SandboxConfig,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async tick(): Promise<void> {
    if (!this.config.enabled) return;
    try {
      await this.check(new Date());
    } catch (error) {
      this.logger.warn(
        `Could not read guest CPU: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async check(now: Date): Promise<void> {
    const held = await this.tenants.find({
      where: { state: SandboxTenantState.CLAIMED },
      select: { id: true, namespace: true, email: true, clusterId: true },
    });
    const byNamespace = new Map(held.map((t) => [t.namespace, t]));

    const hot = await this.hotApps();
    const current = new Map<string, Hot>();
    for (const h of hot) {
      if (byNamespace.has(h.namespace)) current.set(this.key(h), h);
    }

    const open = await this.alerts.openEpisodes('sandbox-cpu/');
    for (const [fingerprint, h] of current) {
      const tenant = byNamespace.get(h.namespace)!;
      await this.raise(
        fingerprint,
        'firing',
        open.get(fingerprint) ?? now,
        now,
        h,
        tenant,
      );
    }

    for (const [fingerprint, since] of open) {
      if (current.has(fingerprint)) continue;
      const [namespace, app] = fingerprint.split('/').slice(1);
      await this.raise(
        fingerprint,
        'resolved',
        since,
        now,
        { namespace, app, percent: 0 },
        byNamespace.get(namespace),
      );
    }
  }

  private async hotApps(): Promise<Hot[]> {
    const { cpuAlertPercent, cpuAlertMinutes } = this.config;
    const response = await this.prometheus.queryInstant(
      `min_over_time(flui:app_cpu_utilization_percent[${cpuAlertMinutes}m]) >= ${cpuAlertPercent}`,
    );
    return (response.data?.result ?? []).map((r) => ({
      namespace: r.metric.namespace ?? '',
      app: r.metric.label_app_kubernetes_io_name ?? '',
      percent: Number(r.value?.[1] ?? 0),
    }));
  }

  private key(h: Pick<Hot, 'namespace' | 'app'>): string {
    return `sandbox-cpu/${h.namespace}/${h.app}`;
  }

  private async raise(
    fingerprint: string,
    status: 'firing' | 'resolved',
    since: Date,
    now: Date,
    h: Hot,
    tenant: Pick<SandboxTenantEntity, 'email' | 'clusterId'> | undefined,
  ): Promise<void> {
    const { cpuAlertPercent, cpuAlertMinutes } = this.config;
    const who = tenant?.email ?? 'a guest';
    const transitions = await this.alerts.record([
      {
        fingerprint,
        status,
        startsAt: since,
        endsAt: status === 'resolved' ? now : null,
        alertname: SandboxCpuAlertService.ALERTNAME,
        severity: 'critical',
        fluiKind: 'sandbox',
        clusterId: tenant?.clusterId ?? null,
        namespace: h.namespace,
        applicationSlug: h.app,
        labels: { guest: who },
        annotations: {
          summary:
            status === 'firing'
              ? `${h.app} of ${who} has run at ${Math.round(h.percent)}% of its CPU limit for ${cpuAlertMinutes} minutes`
              : `${h.app} of ${who} is below ${cpuAlertPercent}% of its CPU limit again`,
          description:
            'Sustained full CPU in a demo area is what mining looks like, and also what a long build looks like. Look at the application before deciding; block the person if it is abuse.',
        },
      },
    ]);
    for (const { kind, event } of transitions) {
      await this.mail.deliver(kind, event);
    }
  }
}
