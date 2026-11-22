import { createHash } from 'node:crypto';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { JSONCodec } from 'nats';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { AlertEventEntity } from '../../observability/entities/alert-event.entity';
import { ClusterNatsEntity } from '../entities/cluster-nats.entity';
import { NatsAccountEntity } from '../entities/nats-account.entity';
import {
  JSZ_REQUEST,
  JSZ_SUBJECT,
  JszReply,
  QueueAlarmSettings,
  QueueBacklog,
  backlogOf,
  judgeQueue,
  queueAlarmSettings,
} from '../nats/queue-backlog';
import { NatsConnectionService } from './nats-connection.service';

export const QUEUE_GROWING_ALERT = 'FluiQueueGrowing';
const QUEUE_KIND = 'queue';

/** Hashed: an account key alone is 56 characters, and the column holds 64. */
export const fingerprintOf = (
  b: Pick<QueueBacklog, 'account' | 'queue'>,
): string => {
  const digest = createHash('sha256')
    .update([b.account, b.queue].join('|'))
    .digest('hex');
  return `${QUEUE_KIND}:${digest.slice(0, 40)}`;
};

interface Owner {
  applicationId: string;
  name: string;
  userId: string | null;
}

/**
 * Watches every application queue on every cluster's NATS and raises an alert
 * when one keeps growing — the worker is down, stuck or too small — and keeps
 * it open until the queue drains. One reading
 * per cluster per round, as the system account, so it costs one tunnel however
 * many applications there are. The readings live in memory: after a restart
 * the window fills again before anything is raised.
 */
@Injectable()
export class QueueAlarmService {
  private readonly logger = new Logger(QueueAlarmService.name);
  private readonly readings = new Map<string, Map<string, number[]>>();
  private readonly settings: QueueAlarmSettings = queueAlarmSettings();
  private running = false;

  constructor(
    @InjectRepository(ClusterNatsEntity)
    private readonly operators: Repository<ClusterNatsEntity>,
    @InjectRepository(NatsAccountEntity)
    private readonly accounts: Repository<NatsAccountEntity>,
    @InjectRepository(ApplicationEntity)
    private readonly applications: Repository<ApplicationEntity>,
    @InjectRepository(AlertEventEntity)
    private readonly events: Repository<AlertEventEntity>,
    private readonly nats: NatsConnectionService,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  @Cron(process.env.QUEUE_ALERT_CRON || '*/5 * * * *')
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const operator of await this.operators.find()) {
        await this.watchCluster(operator).catch((error: Error) =>
          this.logger.warn(
            `Queue readings for cluster ${operator.clusterId} failed: ${error.message}`,
          ),
        );
      }
    } finally {
      this.running = false;
    }
  }

  async watchCluster(operator: ClusterNatsEntity): Promise<void> {
    const backlog = await this.nats.withConnection(
      operator.clusterId,
      operator.systemAccountSeed,
      'flui-queue-watch',
      async (nc) => {
        const codec = JSONCodec<JszReply>();
        const reply = await nc.request(
          JSZ_SUBJECT,
          JSONCodec().encode(JSZ_REQUEST),
          { timeout: 5000 },
        );
        return backlogOf(codec.decode(reply.data));
      },
    );
    const owners = await this.ownersOf(operator.clusterId);
    const open = await this.openAlerts(operator.clusterId);
    const before = this.readings.get(operator.clusterId) ?? new Map();
    const after = new Map<string, number[]>();
    const raise: QueueBacklog[] = [];
    const clear: string[] = [];
    for (const queue of backlog) {
      if (!owners.has(queue.account)) continue;
      const key = fingerprintOf(queue);
      const history = [...(before.get(key) ?? []), queue.waiting].slice(
        -(this.settings.samples + 1),
      );
      after.set(key, history);
      const verdict = judgeQueue(history, this.settings);
      const stillOpen = verdict === 'steady' && open.has(key);
      if (verdict === 'growing' || stillOpen) raise.push(queue);
      if (verdict === 'draining') clear.push(key);
    }
    this.readings.set(operator.clusterId, after);
    for (const key of open.keys()) {
      if (!after.has(key)) clear.push(key);
    }
    await this.deliver(operator.clusterId, raise, owners, clear, open);
  }

  private async ownersOf(clusterId: string): Promise<Map<string, Owner>> {
    const accounts = await this.accounts.find({ where: { clusterId } });
    if (accounts.length === 0) return new Map();
    const apps = await this.applications.find({
      select: ['id', 'name', 'slug', 'userId'],
      where: { id: In(accounts.map((a) => a.applicationId)) },
    });
    const byId = new Map(apps.map((a) => [a.id, a]));
    const owners = new Map<string, Owner>();
    for (const account of accounts) {
      const app = byId.get(account.applicationId);
      if (!app) continue;
      owners.set(account.publicKey, {
        applicationId: app.id,
        name: app.name || app.slug,
        userId: app.userId ?? null,
      });
    }
    return owners;
  }

  private async openAlerts(
    clusterId: string,
  ): Promise<Map<string, AlertEventEntity>> {
    const rows = await this.events.find({
      where: { fluiKind: QUEUE_KIND, status: 'firing', clusterId },
    });
    return new Map(rows.map((r) => [r.fingerprint, r]));
  }

  private async deliver(
    clusterId: string,
    raise: QueueBacklog[],
    owners: Map<string, Owner>,
    clear: string[],
    open: Map<string, AlertEventEntity>,
  ): Promise<void> {
    const incoming = [
      ...raise.map((queue) => {
        const owner = owners.get(queue.account)!;
        const fingerprint = fingerprintOf(queue);
        return {
          fingerprint,
          status: 'firing' as const,
          startsAt: open.get(fingerprint)?.startsAt ?? new Date(),
          endsAt: null,
          alertname: QUEUE_GROWING_ALERT,
          severity: 'warning',
          fluiKind: QUEUE_KIND,
          clusterId,
          applicationId: owner.applicationId,
          labels: { alertname: QUEUE_GROWING_ALERT, queue: queue.queue },
          annotations: {
            summary: `Queue "${queue.queue}" of ${owner.name} keeps growing: ${queue.waiting} messages waiting`,
          },
        };
      }),
      ...clear
        .map((fingerprint) => open.get(fingerprint))
        .filter((row): row is AlertEventEntity => !!row)
        .map((row) => ({
          fingerprint: row.fingerprint,
          status: 'resolved' as const,
          startsAt: row.startsAt,
          endsAt: new Date(),
          alertname: row.alertname,
          severity: row.severity,
          fluiKind: QUEUE_KIND,
          clusterId,
          applicationId: row.applicationId,
          labels: row.labels ?? {},
          annotations: row.annotations ?? {},
        })),
    ];
    if (incoming.length === 0) return;

    const { AlertEventsService } = await import(
      '../../observability/services/alert-events.service'
    );
    const { AlertRoutingService } = await import(
      '../../observability/services/alert-routing.service'
    );
    const recorder = this.moduleRef?.get(AlertEventsService, { strict: false });
    const routing = this.moduleRef?.get(AlertRoutingService, { strict: false });
    if (!recorder || !routing) return;

    const ownerOfApp = new Map(
      [...owners.values()].map((o) => [o.applicationId, o.userId]),
    );
    for (const { kind, event } of await recorder.record(incoming)) {
      void routing.deliver(kind, event, {
        ownerUserId: ownerOfApp.get(event.applicationId ?? '') ?? null,
      });
    }
  }
}
