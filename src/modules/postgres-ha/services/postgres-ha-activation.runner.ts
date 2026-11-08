import { OperationStep } from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { DatabaseHaSpec } from '../postgres-ha.types';
import { PostgresHaDurability } from '../utils/cnpg-cluster.core';
import {
  caughtUpSql,
  copyHbaScript,
  primarySelectorPatch,
  promotionPatch,
  renderCnpgCopyCluster,
  sourceRolesSql,
} from '../utils/postgres-ha-migration.core';

/** What the move needs from the cluster, kept apart so the order can be tested without one. */
export interface HaActivationPorts {
  ensureOperator(): Promise<void>;
  sourceSql(sql: string): Promise<string>;
  sourceShell(script: string): Promise<string>;
  fenceSource(): Promise<void>;
  unfenceSource(): Promise<void>;
  apply(objects: Record<string, unknown>[]): Promise<void>;
  readyInstances(cluster: string): Promise<number>;
  primaryPod(cluster: string): Promise<string | null>;
  clusterSql(pod: string, sql: string): Promise<string>;
  patchCluster(cluster: string, patch: Record<string, unknown>): Promise<void>;
  patchAppService(patch: Record<string, unknown>): Promise<void>;
  scaleSingleInstance(replicas: number): Promise<void>;
  /** The application's password when it signs in as `postgres`, otherwise null. */
  superuserPassword(): Promise<string | null>;
  saveState(spec: DatabaseHaSpec): Promise<void>;
  progress(step: OperationStep, message: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): Date;
}

export interface HaActivationPlan {
  appId: string;
  slug: string;
  namespace: string;
  durability: PostgresHaDurability;
  instances: number;
  preferredZones: string[];
  storageClass: string;
  sizeGi: number;
  podNetwork: string;
  /** Letters and digits only: it is written into SQL as a literal. */
  replicationPassword: string;
}

export interface HaActivationTimeouts {
  copyMs: number;
  catchUpMs: number;
  promoteMs: number;
  pollMs: number;
}

export const DEFAULT_HA_TIMEOUTS: HaActivationTimeouts = {
  copyMs: 30 * 60_000,
  catchUpMs: 60_000,
  promoteMs: 120_000,
  pollMs: 1_000,
};

export class HaActivationError extends Error {
  constructor(
    message: string,
    readonly sourceServes: boolean,
  ) {
    super(message);
  }
}

/**
 * The move from a single instance to a highly available cluster. Until the
 * copy is promoted, any failure puts the single instance back in service;
 * after it, nothing goes back on its own, because the single instance stays
 * fenced and two primaries must never take writes.
 */
export class PostgresHaActivationRunner {
  constructor(
    private readonly ports: HaActivationPorts,
    private readonly timeouts: HaActivationTimeouts = DEFAULT_HA_TIMEOUTS,
  ) {}

  clusterName(plan: HaActivationPlan): string {
    return `${plan.slug}-ha`;
  }

  async run(plan: HaActivationPlan): Promise<DatabaseHaSpec> {
    if (!/^[A-Za-z0-9]{16,}$/.test(plan.replicationPassword)) {
      throw new Error(
        'The replication password must be 16 or more letters and digits',
      );
    }
    const cluster = this.clusterName(plan);
    const state = (
      s: DatabaseHaSpec['state'],
      detail?: string,
    ): DatabaseHaSpec => ({
      engine: 'cnpg',
      cluster,
      durability: plan.durability,
      instances: plan.instances,
      state: s,
      since: this.ports.now().toISOString(),
      ...(detail && { detail }),
    });

    await this.ports.progress(
      OperationStep.DB_HA_PREPARE,
      'Preparing the database for a copy',
    );
    await this.ports.ensureOperator();
    for (const sql of sourceRolesSql(`'${plan.replicationPassword}'`)) {
      await this.ports.sourceSql(sql);
    }
    await this.ports.sourceShell(copyHbaScript(plan.podNetwork));
    await this.ports.sourceSql('SELECT pg_reload_conf()');

    await this.ports.progress(
      OperationStep.DB_HA_COPY,
      'Copying the database into the new cluster',
    );
    const superuserPassword = await this.ports.superuserPassword();
    const labels = {
      'flui-app-id': plan.appId,
      'flui.cloud/managed-by': 'flui-cloud',
    };
    await this.ports.apply([
      ...(superuserPassword
        ? [
            {
              apiVersion: 'v1',
              kind: 'Secret',
              type: 'kubernetes.io/basic-auth',
              metadata: {
                name: `${cluster}-superuser`,
                namespace: plan.namespace,
                labels,
              },
              stringData: { username: 'postgres', password: superuserPassword },
            },
          ]
        : []),
      {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name: `${cluster}-repl`,
          namespace: plan.namespace,
          labels: {
            'flui-app-id': plan.appId,
            'flui.cloud/managed-by': 'flui-cloud',
          },
        },
        stringData: { password: plan.replicationPassword },
      },
      renderCnpgCopyCluster({
        name: cluster,
        namespace: plan.namespace,
        appId: plan.appId,
        instances: plan.instances,
        preferredZones: plan.preferredZones,
        durability: plan.durability,
        storageClass: plan.storageClass,
        sizeGi: plan.sizeGi,
        sourceHost: `${plan.slug}-svc`,
        replicationSecret: `${cluster}-repl`,
        ...(superuserPassword && { superuserSecret: `${cluster}-superuser` }),
      }),
    ]);
    await this.ports.saveState(state('copying'));
    const copied = await this.waitFor(
      this.timeouts.copyMs,
      async () => (await this.ports.readyInstances(cluster)) >= plan.instances,
    );
    if (!copied) {
      const failed = state(
        'failed',
        'The copy did not become ready in time; the database keeps serving from its single instance.',
      );
      await this.ports.saveState(failed);
      throw new HaActivationError(failed.detail!, true);
    }

    await this.ports.progress(
      OperationStep.DB_HA_FENCE,
      'Holding writes while the copy catches up',
    );
    let primary: string | null = null;
    try {
      await this.ports.fenceSource();
      await this.ports.sourceSql('SELECT pg_switch_wal()');
      const lsn = (
        await this.ports.sourceSql('SELECT pg_current_wal_lsn()')
      ).trim();
      primary = await this.ports.primaryPod(cluster);
      const caught =
        primary !== null &&
        (await this.waitFor(
          this.timeouts.catchUpMs,
          async () =>
            (await this.ports.clusterSql(primary!, caughtUpSql(lsn))).trim() ===
            't',
        ));
      if (!caught) throw new Error('The copy did not catch up in time');
    } catch (error) {
      await this.ports.unfenceSource();
      const failed = state(
        'failed',
        `${(error as Error).message}; the database serves from its single instance again.`,
      );
      await this.ports.saveState(failed);
      throw new HaActivationError(failed.detail!, true);
    }

    await this.ports.progress(
      OperationStep.DB_HA_PROMOTE,
      'Promoting the copy',
    );
    await this.ports.patchCluster(cluster, promotionPatch());
    const promoted = await this.waitFor(
      this.timeouts.promoteMs,
      async () =>
        (
          await this.ports.clusterSql(primary!, 'SELECT pg_is_in_recovery()')
        ).trim() === 'f',
    );
    if (!promoted) {
      const failed = state(
        'failed',
        'The copy was asked to take over and has not confirmed it; writes stay held until a person decides.',
      );
      await this.ports.saveState(failed);
      throw new HaActivationError(failed.detail!, false);
    }

    await this.ports.progress(
      OperationStep.DB_HA_SWITCH,
      'Moving the application to the new primary',
    );
    // Recorded before the move: reconciliation reads a stopped single instance
    // as intended only once the database is active.
    const active = state('active');
    await this.ports.saveState(active);
    await this.ports.patchAppService(primarySelectorPatch(plan.slug, cluster));
    await this.ports.scaleSingleInstance(0);
    // The copies restart once the promotion reaches them; the operation ends
    // when every instance serves again, not while they are still settling.
    await this.waitFor(
      this.timeouts.copyMs,
      async () => (await this.ports.readyInstances(cluster)) >= plan.instances,
    );
    return active;
  }

  private async waitFor(
    timeoutMs: number,
    check: () => Promise<boolean>,
  ): Promise<boolean> {
    const deadline = this.ports.now().getTime() + timeoutMs;
    for (;;) {
      if (await check().catch(() => false)) return true;
      if (this.ports.now().getTime() >= deadline) return false;
      await this.ports.sleep(this.timeouts.pollMs);
    }
  }
}
