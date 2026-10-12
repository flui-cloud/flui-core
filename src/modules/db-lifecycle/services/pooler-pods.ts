import { Logger } from '@nestjs/common';
import { Repository } from 'typeorm';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import {
  POOLER_OF_LABEL,
  INSERT_TIMELINE_SQL,
  poolerNames,
} from '../../applications/utils/db-pooler.core';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { describeError } from '../../shared/utils/error.util';
import {
  ShowRow,
  pausedDb,
  poolerAdminScript,
  poolerBackgroundAdminScript,
  poolerShowScript,
  splitShows,
  waitingClients,
} from '../../database-console/engine/pgbouncer-show.core';
import {
  DbPoolerCutRecord,
  PoolerCutRole,
} from '../entities/db-migration.entity';
import { DbPodExecService, ResolvedApp } from './db-pod-exec.service';
import {
  PAUSE_CONFIRM_MS,
  PAUSE_POLL_MS,
  RESTORE_WAIT_COMMANDS,
  RESUME_QUEUE_MS,
  Whoami,
  heldServers,
  killCommand,
  parseWhoami,
  pauseCommand,
  resumeCommand,
  whoamiProbeScript,
} from '../utils/pooler-cut.core';

const POOLER_CONTAINER = 'pgbouncer';
const CYCLE_WAIT_MS = 10_000;
export const PROBE_WINDOW_MS = 15_000;

export interface PoolerTarget {
  appId: string;
  role: PoolerCutRole;
  db: ResolvedApp;
  app: ApplicationEntity;
}

export interface PoolerPod {
  name: string;
  nodeName: string | null;
}

export interface PodShow {
  t: PoolerTarget;
  pod: string;
  show: Record<string, ShowRow[]>;
}

export const messageOf = (e: unknown): string => describeError(e);

function unreachedDetail(seen: Whoami | null, error: string): string {
  if (seen) {
    return ` (recovery ${seen.inRecovery}, timeline ${seen.timeline}, address ${seen.serverAddr ?? '?'})`;
  }
  return error ? `: ${error}` : '';
}

/**
 * What the pooler cut does on each pooler pod and on the database pod beside
 * it: admin commands, `SHOW` reads, probes through the upstream Service. Every
 * admin command goes to a pod, never through a Service.
 */
export class PoolerPods {
  constructor(
    private readonly apps: Repository<ApplicationEntity>,
    private readonly k8s: KubernetesService,
    private readonly exec: DbPodExecService,
    private readonly logger: Logger,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}

  /**
   * `RELOAD` puts the client wait back to the configured one, which a client
   * queued through the whole pause has already outlived: it waits for the
   * queue to empty first, for a bounded time.
   */
  async resumePod(t: PoolerTarget, pod: string): Promise<void> {
    await this.resumeTolerant(t, pod);
    await this.awaitQueueDrained(t, pod);
    await this.admin(t, pod, RESTORE_WAIT_COMMANDS);
  }

  /** A `RESUME` that fails on a pod someone else already resumed is not an error. */
  async resumeTolerant(t: PoolerTarget, pod: string): Promise<void> {
    try {
      await this.admin(t, pod, [resumeCommand(t.db.pgDb)]);
    } catch (e) {
      const show = splitShows(await this.inPod(t, pod, poolerShowScript()));
      if (pausedDb(show.DATABASES, t.db.pgDb)) throw e;
    }
  }

  private async awaitQueueDrained(t: PoolerTarget, pod: string): Promise<void> {
    const deadline = Date.now() + RESUME_QUEUE_MS;
    for (;;) {
      let waiting: number;
      try {
        const show = splitShows(await this.inPod(t, pod, poolerShowScript()));
        waiting = waitingClients(show.POOLS, t.db.pgDb);
      } catch (e) {
        this.logger.warn(
          `[pooler-cut] queue of ${pod} not readable after RESUME: ${messageOf(e)}`,
        );
        return;
      }
      if (waiting === 0) return;
      if (Date.now() >= deadline) {
        this.logger.warn(
          `[pooler-cut] ${pod} still queues ${waiting} client(s) after RESUME; restoring the configured waits`,
        );
        return;
      }
      await this.sleep(PAUSE_POLL_MS);
    }
  }

  async confirmPaused(
    record: DbPoolerCutRecord,
    targets: PoolerTarget[],
    sleep: (ms: number) => Promise<void>,
  ): Promise<void> {
    const deadline = Date.now() + PAUSE_CONFIRM_MS;
    for (;;) {
      const open = (await this.showAll(record, targets)).filter(
        (s) => !pausedDb(s.show.DATABASES, s.t.db.pgDb),
      );
      if (!open.length) return;
      if (Date.now() >= deadline) {
        throw new Error(
          `${open.map((s) => s.pod).join(', ')} did not report ${open[0].t.db.pgDb} paused`,
        );
      }
      await sleep(PAUSE_POLL_MS);
    }
  }

  /**
   * Drop the server connections a pooler holds, so the next ones go wherever
   * the upstream Service now points: `PAUSE` waits for the transactions in
   * flight, and what is still held after a short wait is closed with `KILL`.
   */
  async cycle(t: PoolerTarget): Promise<void> {
    for (const pod of await this.podsOf(t)) {
      await this.adminInBackground(t, pod.name, pauseCommand(t.db.pgDb));
      const deadline = Date.now() + CYCLE_WAIT_MS;
      for (;;) {
        const show = splitShows(
          await this.inPod(t, pod.name, poolerShowScript()),
        );
        if (!heldServers(show.SERVERS).length) break;
        if (Date.now() >= deadline) {
          await this.admin(t, pod.name, [killCommand(t.db.pgDb)]);
          break;
        }
        await this.sleep(PAUSE_POLL_MS);
      }
      await this.resumeTolerant(t, pod.name);
    }
  }

  async probeEach(
    t: PoolerTarget,
    ok: (seen: Whoami | null) => boolean,
    opts: { what: string; windowMs: number; pollMs: number },
    sleep: (ms: number) => Promise<void> = (ms) => this.sleep(ms),
  ): Promise<void> {
    const host = `${poolerNames(t.app.slug).upstream}.${t.db.namespace}.svc.cluster.local`;
    const script = whoamiProbeScript(host, t.db.pgDb);
    const deadline = Date.now() + opts.windowMs;
    for (const pod of await this.podsOf(t)) {
      for (;;) {
        const { seen, error } = await this.whoamiOn(t, pod.name, script);
        if (ok(seen)) break;
        if (Date.now() >= deadline) {
          throw new Error(
            `Pooler pod ${pod.name} does not reach ${opts.what}${unreachedDetail(seen, error)}`,
          );
        }
        await sleep(opts.pollMs);
      }
    }
  }

  private async whoamiOn(
    t: PoolerTarget,
    pod: string,
    script: string,
  ): Promise<{ seen: Whoami | null; error: string }> {
    try {
      return { seen: parseWhoami(await this.inPod(t, pod, script)), error: '' };
    } catch (e) {
      return { seen: null, error: messageOf(e) };
    }
  }

  /** Pooler pods run on the database pod's node; one that does not is refused. */
  async assertColocated(t: PoolerTarget): Promise<void> {
    const pods = await this.podsOf(t);
    if (!pods.length) {
      throw new Error(`The pooler of ${t.app.slug} has no running pod`);
    }
    const dbPods = await this.k8s.listPodsByLabel(
      t.db.kubeconfig,
      t.db.namespace,
      t.db.labelSelector,
    );
    const node = dbPods.find((p) => p.status?.phase === 'Running')?.spec
      ?.nodeName;
    const away = pods.filter((p) => !node || p.nodeName !== node);
    if (away.length) {
      throw new Error(
        `Pooler pod ${away.map((p) => p.name).join(', ')} does not run on the node of ${t.app.slug}'s database`,
      );
    }
  }

  async sourceIdentity(
    src: ResolvedApp,
  ): Promise<{ systemIdentifier: string; timeline: number }> {
    const out = (
      await this.exec.execSql(
        src,
        `SELECT (SELECT system_identifier FROM pg_control_system()) || '|' || (${INSERT_TIMELINE_SQL});`,
      )
    ).trim();
    const [systemIdentifier, tli] = out.split('|');
    const timeline = Number.parseInt(tli ?? '', 10);
    if (!systemIdentifier || !Number.isFinite(timeline)) {
      throw new Error(`Unreadable identity of ${src.slug}: ${out}`);
    }
    return { systemIdentifier, timeline };
  }

  async dbPodIp(t: PoolerTarget): Promise<string | null> {
    const pods = await this.k8s
      .listPodsByLabel(t.db.kubeconfig, t.db.namespace, t.db.labelSelector)
      .catch(() => []);
    return (
      pods.find((p) => p.status?.phase === 'Running')?.status?.podIP ?? null
    );
  }

  async showAll(
    record: DbPoolerCutRecord,
    targets: PoolerTarget[],
  ): Promise<PodShow[]> {
    return Promise.all(
      (record.pausedPods ?? []).flatMap((pp) => {
        const t = targets.find((x) => x.appId === pp.appId);
        if (!t) return [];
        return [
          this.inPod(t, pp.pod, poolerShowScript()).then((out) => ({
            t,
            pod: pp.pod,
            show: splitShows(out) as Record<string, ShowRow[]>,
          })),
        ];
      }),
    );
  }

  async target(appId: string, role: PoolerCutRole): Promise<PoolerTarget> {
    const app = await this.apps.findOne({ where: { id: appId } });
    if (!app) throw new Error(`Application ${appId} not found`);
    return { appId, role, app, db: await this.exec.resolve(appId) };
  }

  async podsOf(t: PoolerTarget): Promise<PoolerPod[]> {
    const pods = await this.k8s.listPodsByLabel(
      t.db.kubeconfig,
      t.db.namespace,
      `${POOLER_OF_LABEL}=${t.appId}`,
    );
    return pods
      .filter(
        (p) =>
          p.status?.phase === 'Running' &&
          !p.metadata?.deletionTimestamp &&
          p.metadata?.name,
      )
      .map((p) => ({
        name: p.metadata!.name!,
        nodeName: p.spec?.nodeName ?? null,
      }));
  }

  admin(t: PoolerTarget, pod: string, commands: string[]): Promise<string> {
    return this.inPod(t, pod, poolerAdminScript(commands));
  }

  adminInBackground(
    t: PoolerTarget,
    pod: string,
    command: string,
  ): Promise<string> {
    return this.inPod(t, pod, poolerBackgroundAdminScript(command));
  }

  inPod(t: PoolerTarget, pod: string, script: string): Promise<string> {
    return this.k8s.execInPod(
      t.db.kubeconfig,
      t.db.namespace,
      `${POOLER_OF_LABEL}=${t.appId}`,
      POOLER_CONTAINER,
      ['sh', '-c', script],
      pod,
    );
  }
}
