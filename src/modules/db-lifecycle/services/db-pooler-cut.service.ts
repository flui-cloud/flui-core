import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { PoolerSpec } from '../../applications/utils/db-pooler.core';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { clusterInternalCidrs } from '../../infrastructure/egress/egress-policy.core';
import { DbPoolerService } from '../../catalog/services/db-pooler.service';
import {
  killClientScript,
  pausedOf,
  poolerShowScript,
  splitShows,
} from '../../database-console/engine/pgbouncer-show.core';
import {
  DbMigrationEntity,
  DbPoolerCutRecord,
  PoolerCutRole,
  PoolerResumedBy,
} from '../entities/db-migration.entity';
import { DbPodExecService } from './db-pod-exec.service';
import { reloadHba } from './hba-reload';
import { DbPhysicalReplicationService } from './db-physical-replication.service';
import {
  physicalNames,
  removeHbaBlockScript,
} from '../utils/physical-replication.core';
import {
  CUT_SETTLE_MS,
  PAUSE_POLL_MS,
  cutSnapshot,
  forwardEgressManifest,
  forwardHbaScript,
  forwardsToSource,
  freshPauseRecord,
  heldServers,
  pauseBudgetMs,
  pauseCommand,
  pauseWaitSeconds,
  raiseWaitCommands,
  reachesPromotedDestination,
} from '../utils/pooler-cut.core';
import { PROBE_WINDOW_MS, PodShow, PoolerPods, messageOf } from './pooler-pods';
import { PoolerUpstreamSwitch } from './pooler-upstream';

const PROBE_POLL_MS = 1_000;
const RETARGET_POLL_MS = 2_000;

export { poolerCutApplies } from '../utils/pooler-cut.core';

/**
 * The poolers' part of a migration with zero rejected writes: the destination
 * pooler forwards to the source's primary while clients reach the destination,
 * both poolers hold their clients while the source is fenced and the copy
 * promoted, then the destination pooler goes back to its own database and lets
 * them through. Every admin command goes to each pooler pod, never through a
 * Service.
 */
@Injectable()
export class DbPoolerCutService {
  private readonly logger = new Logger(DbPoolerCutService.name);
  private readonly podOps: PoolerPods;
  private readonly upstreamSwitch: PoolerUpstreamSwitch;

  constructor(
    @InjectRepository(ApplicationEntity)
    private readonly apps: Repository<ApplicationEntity>,
    @InjectRepository(DbMigrationEntity)
    private readonly migRepo: Repository<DbMigrationEntity>,
    private readonly k8s: KubernetesService,
    private readonly exec: DbPodExecService,
    private readonly poolers: DbPoolerService,
    private readonly physical: DbPhysicalReplicationService,
  ) {
    const sleep = (ms: number) => this.sleep(ms);
    this.podOps = new PoolerPods(apps, k8s, exec, this.logger, sleep);
    this.upstreamSwitch = new PoolerUpstreamSwitch(
      apps,
      k8s,
      this.podOps,
      this.logger,
      sleep,
    );
  }

  /**
   * The destination pooler sends every session to the source's primary over
   * the replication link's transport. Returns the source as the probe saw it.
   */
  async forward(
    linkId: string,
  ): Promise<{ systemIdentifier: string; timeline: number }> {
    const link = await this.physical.getLink(linkId);
    const t = link.transport;
    if (t?.mode !== 'overlay' || !t.host || !t.port || !t.dstHost) {
      throw new Error(`Link ${link.id} has no overlay transport`);
    }
    const src = await this.podOps.target(link.srcAppId, 'source');
    const dst = await this.podOps.target(link.dstAppId, 'destination');
    await this.poolers.ensureRole(src.app, src.db.kubeconfig);
    await this.podOps.assertColocated(dst);

    const names = physicalNames(link.id);
    await this.exec.execRaw(
      src.db,
      forwardHbaScript(names.fwdMarker, src.db.pgDb, t.dstHost),
    );
    await reloadHba(this.exec, src.db);
    await this.k8s.applyManifest(
      dst.db.kubeconfig,
      forwardEgressManifest(
        dst.db.namespace,
        dst.appId,
        names.fwdNetpol,
        t.host,
        t.port,
        clusterInternalCidrs(process.env.FLUI_SUBNET_IP_RANGE),
      ),
    );
    await this.upstreamSwitch.switchUpstream(dst, {
      mode: 'forward',
      address: t.host,
      port: t.port,
      linkId: link.id,
    });
    await this.podOps.cycle(dst);

    const source = await this.podOps.sourceIdentity(src.db);
    await this.podOps.probeEach(dst, (seen) => forwardsToSource(seen, source), {
      what: `forwarding to the source primary (${t.host}:${t.port})`,
      windowMs: PROBE_WINDOW_MS,
      pollMs: PROBE_POLL_MS,
    });
    this.logger.log(
      `[pooler-cut] ${dst.app.slug} forwards to ${src.app.slug} through link ${link.id}`,
    );
    return source;
  }

  /**
   * Undo of `forward`, before any promote: the destination pooler back on its
   * own database, the egress policy and the source's hba block gone. Each step
   * runs even when an earlier one failed; what is left is returned.
   */
  async unforward(linkId: string): Promise<string[]> {
    const notes: string[] = [];
    const link = await this.physical.getLink(linkId);
    const names = physicalNames(link.id);
    const dst = await this.podOps
      .target(link.dstAppId, 'destination')
      .catch((e: unknown) => {
        notes.push(`destination not reachable: ${messageOf(e)}`);
        return null;
      });
    if (dst?.app.pooler?.upstream.mode === 'forward') {
      try {
        await this.upstreamSwitch.switchUpstream(dst, { mode: 'local' });
        await this.podOps.cycle(dst);
      } catch (e) {
        notes.push(
          `destination pooler not back on its database: ${messageOf(e)}`,
        );
      }
    }
    if (dst) {
      await this.k8s
        .deleteResource(
          dst.db.kubeconfig,
          'NetworkPolicy',
          names.fwdNetpol,
          dst.db.namespace,
        )
        .catch((e) =>
          notes.push(`${names.fwdNetpol} not removed: ${messageOf(e)}`),
        );
    }
    try {
      const src = await this.exec.resolve(link.srcAppId);
      await this.exec.execRaw(src, removeHbaBlockScript(names.fwdMarker));
      await reloadHba(this.exec, src);
    } catch (e) {
      notes.push(`forward block not removed from the source: ${messageOf(e)}`);
    }
    if (notes.length) {
      this.logger.warn(
        `[pooler-cut] unforward ${link.id}: ${notes.join('; ')}`,
      );
    }
    return notes;
  }

  /**
   * Raise the client wait, start `PAUSE` on every pooler pod and see each one
   * report the database paused, then wait for them to release their server
   * connections until the deadline. Whoever still
   * holds one then is recorded: the fence that follows is what cuts them.
   * A pod that cannot be paused undoes the pause on every pod first.
   */
  async pause(
    mig: DbMigrationEntity,
    drainMs: number,
    sleep: (ms: number) => Promise<void>,
  ): Promise<DbPoolerCutRecord> {
    const plan = freshPauseRecord(mig.poolerCut as DbPoolerCutRecord);
    const budgetMs = pauseBudgetMs(plan.deadlineMs, drainMs);
    const waitS = pauseWaitSeconds(budgetMs);
    const targets = await Promise.all(
      plan.poolers.map((p) => this.podOps.target(p.appId, p.role)),
    );
    const pods = await Promise.all(
      targets.map(async (t) => ({ t, pods: await this.podOps.podsOf(t) })),
    );
    let record: DbPoolerCutRecord = {
      ...plan,
      budgetMs,
      pausedPods: pods.flatMap(({ t, pods: list }) =>
        list.map((p) => ({ appId: t.appId, pod: p.name })),
      ),
    };
    await this.persist(mig, record);
    try {
      await Promise.all(
        pods.flatMap(({ t, pods: list }) =>
          list.map(async (p) => {
            await this.podOps.admin(t, p.name, raiseWaitCommands(waitS));
            await this.podOps.adminInBackground(
              t,
              p.name,
              pauseCommand(t.db.pgDb),
            );
          }),
        ),
      );
      await this.podOps.confirmPaused(record, targets, sleep);
    } catch (err) {
      const notes = await this.resumeRoles(
        mig,
        ['source', 'destination'],
        'rollback',
      );
      const resumeNote = notes.length ? `; ${notes.join('; ')}` : '';
      throw new Error(
        `The pooler could not be paused: ${messageOf(err)}${resumeNote}`,
      );
    }
    record = { ...record, pausedAt: new Date().toISOString() };
    await this.persist(mig, record);

    const deadline = Date.now() + plan.deadlineMs;
    let last: PodShow[] = [];
    for (;;) {
      last = await this.podOps.showAll(record, targets);
      if (last.every((s) => heldServers(s.show.SERVERS).length === 0)) {
        record = { ...record, drainedAt: new Date().toISOString(), cut: [] };
        break;
      }
      if (Date.now() >= deadline) {
        const at = new Date();
        record = {
          ...record,
          cut: last.flatMap((s) =>
            cutSnapshot(s.pod, s.t.role, s.show.SERVERS, s.show.CLIENTS, at),
          ),
        };
        break;
      }
      await sleep(PAUSE_POLL_MS);
    }
    await this.persist(mig, record);
    return record;
  }

  /**
   * After the fence: its terminate already ended the server connections the
   * poolers still held. Give the poolers a moment to notice, then close the
   * clients still linked to a server, so the pause completes either way.
   */
  async settleAfterFence(
    mig: DbMigrationEntity,
    sleep: (ms: number) => Promise<void>,
  ): Promise<void> {
    let record = mig.poolerCut as DbPoolerCutRecord;
    record = { ...record, fencedAt: new Date().toISOString() };
    await this.persist(mig, record);
    if (!record.cut?.length) return;
    const targets = await Promise.all(
      record.poolers.map((p) => this.podOps.target(p.appId, p.role)),
    );
    const deadline = Date.now() + CUT_SETTLE_MS;
    for (;;) {
      const shows = await this.podOps.showAll(record, targets).catch(() => []);
      const left = shows.filter((s) => heldServers(s.show.SERVERS).length);
      if (!left.length) return;
      if (Date.now() >= deadline) {
        await this.killLinkedClients(left);
        return;
      }
      await sleep(PAUSE_POLL_MS);
    }
  }

  private async killLinkedClients(left: PodShow[]): Promise<void> {
    for (const s of left) {
      const linked = new Set(heldServers(s.show.SERVERS).map((r) => r.link));
      for (const c of s.show.CLIENTS) {
        const id = Number.parseInt(c.id ?? '', 10);
        if (!c.ptr || !linked.has(c.ptr) || !Number.isFinite(id)) continue;
        await this.podOps
          .inPod(s.t, s.pod, killClientScript(id))
          .catch((e) =>
            this.logger.warn(
              `[pooler-cut] KILL_CLIENT ${id} on ${s.pod}: ${messageOf(e)}`,
            ),
          );
      }
    }
  }

  /**
   * After the promote: the destination pooler back on its own database, proven
   * by a probe from each pod, then let through. Never resumed while the probe
   * does not see the promoted copy: the source is fenced, so resuming against
   * it would only turn the wait into errors.
   */
  async retargetAndResume(
    mig: DbMigrationEntity,
    sleep: (ms: number) => Promise<void>,
  ): Promise<DbPoolerCutRecord> {
    let record = mig.poolerCut as DbPoolerCutRecord;
    const dst = record.poolers.find((p) => p.role === 'destination');
    if (!dst) return record;
    const t = await this.podOps.target(dst.appId, 'destination');
    const upstream = t.app.pooler?.upstream;
    const linkId =
      mig.linkId ?? (upstream?.mode === 'forward' ? upstream.linkId : null);
    if (upstream?.mode !== 'local') {
      await this.upstreamSwitch.switchUpstream(t, { mode: 'local' });
    }
    const dropped = linkId
      ? await this.upstreamSwitch.dropForwardEgress(t, linkId)
      : [];
    const podIp = await this.podOps.dbPodIp(t);
    if (!podIp) {
      throw new Error(
        `The database pod of ${t.app.slug} has no address to tell the promoted copy by`,
      );
    }
    record = { ...record, retargetedAt: new Date().toISOString() };
    await this.persist(mig, record);
    const sysid =
      record.sourceSystemIdentifier ??
      (await this.podOps.sourceIdentity(t.db)).systemIdentifier;
    const pausedAt = record.pausedAt ? Date.parse(record.pausedAt) : Date.now();
    const windowMs = Math.max(
      PROBE_WINDOW_MS,
      pausedAt + (record.budgetMs ?? 0) - Date.now(),
    );
    await this.podOps.probeEach(
      t,
      (seen) =>
        reachesPromotedDestination(seen, {
          systemIdentifier: sysid,
          sourceTimeline: record.sourceTimeline ?? null,
          dstPodIp: podIp,
        }),
      { what: 'the promoted destination', windowMs, pollMs: RETARGET_POLL_MS },
      sleep,
    );
    const notes = await this.resumeRoles(mig, ['destination'], 'retarget');
    record = {
      ...(mig.poolerCut as DbPoolerCutRecord),
      resumedAt: new Date().toISOString(),
      resumedBy: 'retarget',
      sourceLeftPaused: true,
      notes: [...(record.notes ?? []), ...dropped, ...notes],
    };
    await this.persist(mig, record);
    this.logger.log(
      `[pooler-cut] ${t.app.slug} serves from its promoted database`,
    );
    return record;
  }

  /**
   * `RESUME` and the configured timeouts back, on the paused pods of these
   * roles. Once every one of them let its clients through, the record says
   * when and why, so the pause reads as over.
   */
  async resumeRoles(
    mig: DbMigrationEntity,
    roles: PoolerCutRole[],
    by: PoolerResumedBy,
  ): Promise<string[]> {
    const record = mig.poolerCut;
    if (!record?.pausedPods?.length) return [];
    const notes: string[] = [];
    for (const p of record.poolers.filter((x) => roles.includes(x.role))) {
      const t = await this.podOps
        .target(p.appId, p.role)
        .catch((e: unknown) => {
          notes.push(`pooler of ${p.appId} not reachable: ${messageOf(e)}`);
          return null;
        });
      if (!t) continue;
      for (const pp of record.pausedPods.filter((x) => x.appId === p.appId)) {
        try {
          await this.podOps.resumePod(t, pp.pod);
        } catch (e) {
          notes.push(`${pp.pod} not resumed: ${messageOf(e)}`);
        }
      }
    }
    if (!notes.length) {
      await this.persist(mig, {
        ...(mig.poolerCut as DbPoolerCutRecord),
        resumedAt: new Date().toISOString(),
        resumedBy: by,
      });
    }
    return notes;
  }

  /** The source pooler stays paused for good: the sweeper must leave it alone. */
  async suspendSource(mig: DbMigrationEntity): Promise<void> {
    const src = mig.poolerCut?.poolers.find((p) => p.role === 'source');
    if (!src) return;
    const app = await this.apps.findOne({ where: { id: src.appId } });
    if (!app?.pooler || app.pooler.suspended) return;
    const pooler: PoolerSpec = { ...app.pooler, suspended: true };
    await this.apps.update(app.id, { pooler } as never);
  }

  /** Whether any pod of this pooler reports a paused database. */
  async pausedPods(appId: string): Promise<string[]> {
    const t = await this.podOps.target(appId, 'destination');
    const out: string[] = [];
    for (const pod of await this.podOps.podsOf(t)) {
      const show = splitShows(
        await this.podOps.inPod(t, pod.name, poolerShowScript()),
      );
      if (pausedOf(show.DATABASES)) out.push(pod.name);
    }
    return out;
  }

  /** A pooler left forwarding or paused by an interrupted migration, put back to serving. */
  async release(appId: string, opts: { retarget: boolean }): Promise<string[]> {
    const t = await this.podOps.target(appId, 'destination');
    if (opts.retarget && t.app.pooler?.upstream.mode === 'forward') {
      await this.upstreamSwitch.switchUpstream(t, { mode: 'local' });
    }
    const resumed: string[] = [];
    for (const pod of await this.podOps.podsOf(t)) {
      const show = splitShows(
        await this.podOps.inPod(t, pod.name, poolerShowScript()),
      );
      if (!pausedOf(show.DATABASES)) continue;
      await this.podOps.resumePod(t, pod.name);
      resumed.push(pod.name);
    }
    return resumed;
  }

  private async persist(
    mig: DbMigrationEntity,
    record: DbPoolerCutRecord,
  ): Promise<void> {
    mig.poolerCut = record;
    await this.migRepo.update(mig.id, { poolerCut: record } as never);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
