import { Injectable } from '@nestjs/common';
import type { V1Pod } from '@kubernetes/client-node';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { describeError } from '../../shared/utils/error.util';
import {
  POOLER_OF_LABEL,
  PoolerSpec,
} from '../../applications/utils/db-pooler.core';
import { DbPoolerViewDto, DbSessionAppRefDto } from '../dto/db-sessions.dto';
import {
  PoolerPodShow,
  clientsOf,
  killClientScript,
  pausedOf,
  poolerShowScript,
  poolsOf,
  splitShows,
} from '../engine/pgbouncer-show.core';

export { POOLER_OF_LABEL };

const POOLER_CONTAINER = 'pgbouncer';

export interface DbPoolerViewInput {
  appId: string;
  namespace: string;
  kubeconfig: string;
  pooler: PoolerSpec | null | undefined;
  appByAddr: ReadonlyMap<string, DbSessionAppRefDto>;
}

export interface PooledClientRef {
  pod: string;
  clientId: number;
  connectTime: string;
}

/**
 * The pooler's half of the sessions view: its pools and pooled clients, read
 * from each pooler pod's admin console. Null when the database has no pooler.
 */
export interface DbPoolerViewSource {
  view(input: DbPoolerViewInput): Promise<DbPoolerViewDto | null>;
  /** `gone` when that client is no longer the one listed: ended, or its id reused. */
  closeClient(
    input: DbPoolerViewInput,
    client: PooledClientRef,
  ): Promise<'closed' | 'gone'>;
}

export const DB_POOLER_VIEW_SOURCE = Symbol('DB_POOLER_VIEW_SOURCE');

/** PgBouncer's admin console, one exec per pooler pod (`SHOW` and `KILL_CLIENT`). */
@Injectable()
export class PgbouncerAdminViewSource implements DbPoolerViewSource {
  constructor(private readonly kubernetes: KubernetesService) {}

  async view(input: DbPoolerViewInput): Promise<DbPoolerViewDto | null> {
    const spec = input.pooler;
    if (!spec?.enabled) return null;
    const base: DbPoolerViewDto = {
      mode: spec.mode,
      paused: false,
      upstream: spec.upstream.mode,
      reason: null,
      pools: [],
      clients: [],
    };
    let pods: string[];
    try {
      pods = await this.runningPods(input);
    } catch (e) {
      return {
        ...base,
        reason: `Could not list the pooler pods: ${describeError(e)}`,
      };
    }
    if (!pods.length) {
      return {
        ...base,
        reason: spec.suspended
          ? 'The pooler is suspended.'
          : 'No pooler pod is running.',
      };
    }
    const reads = await Promise.allSettled(
      pods.map((pod) => this.read(input, pod)),
    );
    const shows = reads.flatMap((r) =>
      r.status === 'fulfilled' ? [r.value] : [],
    );
    const failed = reads.findIndex((r) => r.status === 'rejected');
    return {
      ...base,
      paused: shows.some((s) => s.paused),
      reason:
        failed === -1
          ? null
          : `Could not read pooler pod ${pods[failed]}: ${describeError(
              (reads[failed] as PromiseRejectedResult).reason,
            )}`,
      pools: poolsOf(shows),
      clients: clientsOf(shows, input.appByAddr),
    };
  }

  async closeClient(
    input: DbPoolerViewInput,
    client: PooledClientRef,
  ): Promise<'closed' | 'gone'> {
    const pods = await this.runningPods(input);
    if (!pods.includes(client.pod)) return 'gone';
    const show = await this.read(input, client.pod);
    const listed = clientsOf([show], new Map()).find(
      (c) => c.id === client.clientId && c.connectTime === client.connectTime,
    );
    if (!listed?.canClose) return 'gone';
    await this.exec(input, client.pod, killClientScript(client.clientId));
    return 'closed';
  }

  private async runningPods(input: DbPoolerViewInput): Promise<string[]> {
    const pods: V1Pod[] = await this.kubernetes.listPodsByLabel(
      input.kubeconfig,
      input.namespace,
      `${POOLER_OF_LABEL}=${input.appId}`,
    );
    return pods
      .filter((p) => p.status?.phase === 'Running' && p.metadata?.name)
      .map((p) => p.metadata!.name!);
  }

  private async read(
    input: DbPoolerViewInput,
    pod: string,
  ): Promise<PoolerPodShow & { paused: boolean }> {
    const sections = splitShows(
      await this.exec(input, pod, poolerShowScript()),
    );
    return {
      pod,
      pools: sections.POOLS,
      clients: sections.CLIENTS,
      servers: sections.SERVERS,
      paused: pausedOf(sections.DATABASES),
    };
  }

  private exec(
    input: DbPoolerViewInput,
    pod: string,
    script: string,
  ): Promise<string> {
    return this.kubernetes.execInPod(
      input.kubeconfig,
      input.namespace,
      `${POOLER_OF_LABEL}=${input.appId}`,
      POOLER_CONTAINER,
      ['sh', '-c', script],
      pod,
    );
  }
}
