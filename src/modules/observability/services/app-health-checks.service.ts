import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';

export interface HealthCheckFailures {
  /** Failed readiness checks in the last hour, whatever the cause. */
  readiness: number;
  /**
   * The part of them where the copy was there but too slow to answer: a busy
   * copy. The rest is a copy not listening, mostly one starting or stopping.
   */
  readinessBusy: number;
  /** Failed checks that count toward a restart. */
  liveness: number;
  startup: number;
  /** Copies restarted because the liveness check kept failing. */
  restartsByLiveness: number;
  lastFailureAt: string | null;
  /** False when the cluster could not be asked: nothing was counted, which is not the same as zero. */
  read: boolean;
}

const WINDOW_MS = 60 * 60 * 1000;

/**
 * What the cluster itself saw of an application's health checks over the last
 * hour, from its events. A copy can stop answering for twenty seconds and be
 * back before the next metrics sample; the event stays.
 */
@Injectable()
export class AppHealthChecksService {
  private readonly logger = new Logger(AppHealthChecksService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    private readonly kubernetes: KubernetesService,
    private readonly encryption: EncryptionService,
  ) {}

  async failures(app: {
    slug: string;
    k8sNamespace: string;
    clusterId?: string | null;
  }): Promise<HealthCheckFailures> {
    const empty: HealthCheckFailures = {
      readiness: 0,
      readinessBusy: 0,
      liveness: 0,
      startup: 0,
      restartsByLiveness: 0,
      lastFailureAt: null,
      read: false,
    };
    if (!app.clusterId) return empty;
    try {
      const cluster = await this.clusters.findOne({
        where: { id: app.clusterId },
        select: { id: true, kubeconfigEncrypted: true },
      });
      if (!cluster?.kubeconfigEncrypted) return empty;
      const events = await this.kubernetes.listEvents(
        this.encryption.decrypt(cluster.kubeconfigEncrypted),
        app.k8sNamespace,
      );
      return countFailures(events, app.slug, Date.now());
    } catch (error) {
      this.logger.warn(
        `Could not read the events of ${app.slug}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return empty;
    }
  }
}

interface EventLike {
  reason?: string;
  message?: string;
  count?: number;
  lastTimestamp?: Date | string | null;
  eventTime?: Date | string | null;
  involvedObject?: { kind?: string; name?: string };
}

/** Pods of a Deployment (`<slug>-<hash>-<id>`) or a StatefulSet (`<slug>-<n>`). */
const podOf = (slug: string) => {
  const escaped = slug.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  return new RegExp(
    String.raw`^${escaped}-(?:[a-z0-9]{5,10}-[a-z0-9]{5}|\d+)$`,
  );
};

const TOO_SLOW = /Client\.Timeout|deadline exceeded|i\/o timeout|timed out/i;

type Failure = 'readiness' | 'liveness' | 'startup' | 'restart';

function failureOf(event: EventLike): Failure | null {
  const message = event.message ?? '';
  if (event.reason === 'Unhealthy') {
    if (message.startsWith('Readiness probe failed')) return 'readiness';
    if (message.startsWith('Liveness probe failed')) return 'liveness';
    if (message.startsWith('Startup probe failed')) return 'startup';
    return null;
  }
  if (event.reason === 'Killing' && message.includes('failed liveness probe')) {
    return 'restart';
  }
  return null;
}

function tally(
  result: HealthCheckFailures,
  failure: Failure,
  times: number,
  message: string,
): void {
  if (failure === 'readiness') {
    result.readiness += times;
    if (TOO_SLOW.test(message)) result.readinessBusy += times;
  } else if (failure === 'liveness') {
    result.liveness += times;
  } else if (failure === 'startup') {
    result.startup += times;
  } else {
    result.restartsByLiveness += times;
  }
}

export function countFailures(
  events: EventLike[],
  slug: string,
  now: number,
): HealthCheckFailures {
  const mine = podOf(slug);
  const result: HealthCheckFailures = {
    readiness: 0,
    readinessBusy: 0,
    liveness: 0,
    startup: 0,
    restartsByLiveness: 0,
    lastFailureAt: null,
    read: true,
  };
  let last = 0;
  for (const event of events) {
    if (event.involvedObject?.kind !== 'Pod') continue;
    if (!mine.test(event.involvedObject.name ?? '')) continue;
    const at = new Date(event.lastTimestamp ?? event.eventTime ?? 0).getTime();
    if (!at || now - at > WINDOW_MS) continue;
    const failure = failureOf(event);
    if (!failure) continue;
    tally(result, failure, Math.max(event.count ?? 1, 1), event.message ?? '');
    last = Math.max(last, at);
  }
  result.lastFailureAt = last ? new Date(last).toISOString() : null;
  return result;
}
