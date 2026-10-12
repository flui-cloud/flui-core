import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomBytes } from 'node:crypto';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { WireGuardLinkService } from '../../infrastructure/networking/services/wireguard-link.service';
import { DbReplicationLinkEntity } from '../entities/db-replication-link.entity';
import {
  DbReplicationKind,
  DbReplicationStatus,
} from '../enums/db-replication-status.enum';
import { DbPodExecService } from './db-pod-exec.service';
import {
  DbOverlayTransportService,
  STANDBY_DIR,
} from './db-overlay-transport.service';
import { PodPlacement } from './db-pod-placement.service';
import { PhysicalSourcePrep } from './physical-source-prep';
import { PhysicalLinkTeardown } from './physical-link-teardown';
import {
  PhysicalStatusView,
  PromoteUnconfirmedError,
  RecoveryState,
  SlotLostError,
  StandbyState,
  physicalNames,
} from '../utils/physical-replication.core';

export type {
  PhysicalNames,
  PhysicalStatusView,
  RecoveryState,
  StandbyState,
} from '../utils/physical-replication.core';
export {
  PROMOTED_HBA_CLEANUP_SCRIPT,
  PromoteUnconfirmedError,
  SlotLostError,
  physicalNames,
  promotedSettingsResetSql,
  removeHbaBlockScript,
  replicationHbaScript,
} from '../utils/physical-replication.core';

const LSN_RE = /^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/i;

/**
 * Physical replication of a managed Postgres to another cluster over a
 * temporary direct WireGuard link: a per-link role and slot on the source, a
 * `pg_hba` block that admits that role from the destination node's overlay
 * address only, the destination bootstrapped as a hot standby by its image,
 * and a promote the control plane orders once the fenced source's last LSN has
 * been replayed. B is never promoted on abort: that would be a second writable
 * copy with the same system identifier.
 */
@Injectable()
export class DbPhysicalReplicationService {
  private readonly logger = new Logger(DbPhysicalReplicationService.name);
  private readonly sourcePrep: PhysicalSourcePrep;
  private readonly teardown: PhysicalLinkTeardown;

  constructor(
    @InjectRepository(DbReplicationLinkEntity)
    private readonly linkRepo: Repository<DbReplicationLinkEntity>,
    private readonly encryption: EncryptionService,
    private readonly exec: DbPodExecService,
    private readonly transport: DbOverlayTransportService,
    private readonly wgLinks: WireGuardLinkService,
  ) {
    this.sourcePrep = new PhysicalSourcePrep(
      linkRepo,
      encryption,
      exec,
      transport,
      this.logger,
    );
    this.teardown = new PhysicalLinkTeardown(
      linkRepo,
      exec,
      transport,
      wgLinks,
      this.logger,
      (link) => this.recoveryState(link),
    );
  }

  async createLink(
    srcAppId: string,
    dstAppId: string,
    nodes: { srcNodeId: string; dstNodeId: string },
  ): Promise<DbReplicationLinkEntity> {
    if (srcAppId === dstAppId) {
      throw new BadRequestException('src and dst must differ');
    }
    const link = await this.linkRepo.save(
      this.linkRepo.create({
        kind: DbReplicationKind.PHYSICAL,
        srcAppId,
        dstAppId,
        srcNodeId: nodes.srcNodeId,
        dstNodeId: nodes.dstNodeId,
        pubName: '',
        subName: '',
        slotName: '',
        replRolePasswordEncrypted: this.encryption.encrypt(
          randomBytes(24).toString('base64url'),
        ),
        status: DbReplicationStatus.INIT,
      }),
    );
    const names = physicalNames(link.id);
    link.slotName = names.slot;
    link.replRole = names.role;
    return this.linkRepo.save(link);
  }

  async getLink(linkId: string): Promise<DbReplicationLinkEntity> {
    const link = await this.linkRepo.findOne({ where: { id: linkId } });
    if (!link)
      throw new BadRequestException(`Replication link ${linkId} not found`);
    return link;
  }

  async markStreaming(link: DbReplicationLinkEntity): Promise<void> {
    link.status = DbReplicationStatus.STREAMING;
    link.errorMessage = undefined;
    await this.linkRepo.save(link);
  }

  async markPromoted(link: DbReplicationLinkEntity): Promise<void> {
    if (link.status === DbReplicationStatus.PROMOTED) return;
    link.status = DbReplicationStatus.PROMOTED;
    link.lagBytes = '0';
    await this.linkRepo.save(link);
  }

  /** The copy needs the source's data directory, and some room to spare, free on the destination's volume. */
  async assertRoomOnDestination(link: DbReplicationLinkEntity): Promise<void> {
    const src = await this.exec.resolve(link.srcAppId);
    const dst = await this.exec.resolve(link.dstAppId);
    const size = Number(
      (await this.exec.execRaw(src, `du -sb "$PGDATA" | cut -f1`)).trim(),
    );
    const avail = Number(
      (
        await this.exec.execRaw(
          dst,
          `df -B1 --output=avail ${dst.pvcRoot} | tail -1`,
        )
      ).trim(),
    );
    if (!size || !avail) {
      throw new BadRequestException(
        `Could not measure the copy (source ${size || '?'} bytes, destination free ${avail || '?'} bytes)`,
      );
    }
    if (size * 1.1 > avail) {
      throw new BadRequestException(
        `The destination volume has ${avail} bytes free; the source data directory is ${size} bytes`,
      );
    }
  }

  /**
   * Link, handshake, source prepared, Service on the source's overlay address,
   * egress policy on the destination, and a probe from the destination pod.
   * Every step is idempotent, so a resumed run repeats it safely.
   */
  async openTransport(
    link: DbReplicationLinkEntity,
    src: PodPlacement,
    dst: PodPlacement,
  ): Promise<DbReplicationLinkEntity> {
    if (src.clusterId === dst.clusterId) {
      throw new BadRequestException(
        'A physical migration needs the destination on another cluster',
      );
    }
    const wg = await this.wgLinks.open({
      purpose: 'db-replication',
      ownerId: link.id,
      listenerNodeId: src.nodeId,
      dialerNodeId: dst.nodeId,
    });
    link.wgLinkId = wg.id;
    await this.linkRepo.save(link);
    await this.wgLinks.awaitHandshake(wg.id);

    await this.prepareSource(
      link,
      src.overlayIp,
      dst.overlayIp,
      wg.serviceTcpPort,
    );

    const names = physicalNames(link.id);
    const dstApp = await this.exec.resolve(link.dstAppId);
    await this.transport.restrictEgress(
      dstApp,
      names.netpol,
      src.overlayIp,
      wg.serviceTcpPort,
    );
    link.transport = {
      ...(link.transport ?? { mode: 'overlay' }),
      netpolName: names.netpol,
    };
    await this.linkRepo.save(link);
    await this.transport.probe(dstApp, src.overlayIp, wg.serviceTcpPort);
    return link;
  }

  async prepareSource(
    link: DbReplicationLinkEntity,
    srcOverlayIp: string,
    dstOverlayIp: string,
    port: number,
  ): Promise<void> {
    return this.sourcePrep.prepare(link, srcOverlayIp, dstOverlayIp, port);
  }

  /** Same major and architecture; a different image digest is only a warning. */
  async checkCompatibility(
    link: DbReplicationLinkEntity,
    placements?: { src?: PodPlacement; dst?: PodPlacement },
  ): Promise<string[]> {
    const src = await this.exec.resolve(link.srcAppId);
    const dst = await this.exec.resolve(link.dstAppId);
    const srcMajor = Math.floor(
      Number(
        (await this.exec.execSql(src, 'SHOW server_version_num;')).trim(),
      ) / 10000,
    );
    const dstMajor = Number(
      /\(PostgreSQL\)\s+(\d+)/.exec(
        await this.exec.execRaw(dst, 'postgres --version'),
      )?.[1],
    );
    if (!srcMajor || srcMajor !== dstMajor) {
      throw new BadRequestException(
        `Postgres major differs: source ${srcMajor || '?'}, destination ${dstMajor || '?'}`,
      );
    }
    const srcArch = (await this.exec.execRaw(src, 'uname -m')).trim();
    const dstArch = (await this.exec.execRaw(dst, 'uname -m')).trim();
    if (!srcArch || srcArch !== dstArch) {
      throw new BadRequestException(
        `Architecture differs: source ${srcArch || '?'}, destination ${dstArch || '?'} — data files are not portable`,
      );
    }
    const warnings: string[] = [];
    const a = placements?.src?.imageId;
    const b = placements?.dst?.imageId;
    if (a && b && a !== b) {
      warnings.push(`image differs: source ${a}, destination ${b}`);
    }
    if (warnings.length) {
      link.transport = {
        ...(link.transport ?? { mode: 'overlay' }),
        warnings: [
          ...new Set([...(link.transport?.warnings ?? []), ...warnings]),
        ],
      };
      await this.linkRepo.save(link);
    }
    return warnings;
  }

  async attachStandby(link: DbReplicationLinkEntity): Promise<void> {
    const t = link.transport;
    if (t?.mode !== 'overlay' || !t.host || !t.port || !t.caPath) {
      throw new BadRequestException(
        `Link ${link.id} has no overlay transport yet`,
      );
    }
    const names = physicalNames(link.id);
    const src = await this.exec.resolve(link.srcAppId);
    const dst = await this.exec.resolve(link.dstAppId);
    const password = this.encryption.decrypt(link.replRolePasswordEncrypted);
    await this.transport.attachStandby(dst, {
      caPath: t.caPath,
      caPem: await this.transport.serverCertificate(src),
      slot: names.slot,
      conninfo: `host=${t.host} port=${t.port} user=${names.role} password=${password} application_name=${names.application} sslmode=verify-ca sslrootcert=${t.caPath}\n`,
    });
    link.status = DbReplicationStatus.COPYING;
    await this.linkRepo.save(link);
  }

  async standbyState(link: DbReplicationLinkEntity): Promise<StandbyState> {
    const dst = await this.exec.resolve(link.dstAppId);
    const done =
      (
        await this.exec.execRaw(
          dst,
          `test -f ${dst.pvcRoot}/${STANDBY_DIR}/done && echo yes || echo no`,
        )
      ).trim() === 'yes';
    if (!done) return { done, inRecovery: null };
    const recovery = await this.recoveryState(link);
    return {
      done,
      inRecovery: recovery === 'unknown' ? null : recovery === 'standby',
    };
  }

  /** Same cluster identity on both ends, and the destination's collations match the copied catalog. */
  async verifyCopy(link: DbReplicationLinkEntity): Promise<void> {
    const src = await this.exec.resolve(link.srcAppId);
    const dst = await this.exec.resolve(link.dstAppId);
    const sysid = 'SELECT system_identifier FROM pg_control_system();';
    const a = (await this.exec.execSql(src, sysid)).trim();
    const b = (await this.exec.execSql(dst, sysid)).trim();
    if (!a || a !== b) {
      throw new BadRequestException(
        `The destination is not a copy of the source (system identifier ${a} vs ${b})`,
      );
    }
    const drift = (
      await this.exec.execSql(
        dst,
        `SELECT coalesce(string_agg(datname, ','), '') FROM pg_database WHERE datcollversion IS NOT NULL AND datcollversion IS DISTINCT FROM pg_database_collation_actual_version(oid);`,
      )
    ).trim();
    if (drift) {
      throw new BadRequestException(
        `Collation version differs on the destination for ${drift}: its text indexes would be corrupt after promote`,
      );
    }
  }

  /** Read side; a slot the source invalidated fails the link. */
  async status(link: DbReplicationLinkEntity): Promise<PhysicalStatusView> {
    const names = physicalNames(link.id);
    const src = await this.exec.resolve(link.srcAppId);
    const row = (
      await this.exec.execSql(
        src,
        [
          `SELECT coalesce((SELECT state FROM pg_stat_replication WHERE application_name='${names.application}' ORDER BY state = 'streaming' DESC LIMIT 1),'')`,
          ` || '|' || coalesce((SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)::bigint::text FROM pg_stat_replication WHERE application_name='${names.application}' AND replay_lsn IS NOT NULL LIMIT 1),'')`,
          ` || '|' || coalesce((SELECT active::text FROM pg_replication_slots WHERE slot_name='${names.slot}'),'')`,
          ` || '|' || coalesce((SELECT wal_status FROM pg_replication_slots WHERE slot_name='${names.slot}'),'')`,
          ` || '|' || coalesce((SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)::bigint::text FROM pg_replication_slots WHERE slot_name='${names.slot}'),'');`,
        ].join(''),
      )
    ).trim();
    const [state, lag, active, walStatus, retained] = row.split('|');
    if (!active || walStatus === 'lost') {
      link.status = DbReplicationStatus.FAILED;
      link.errorMessage = !active
        ? `replication slot ${names.slot} is gone from the source`
        : `the source dropped WAL the destination still needed (slot ${names.slot} lost); the copy must start again`;
      await this.linkRepo.save(link);
      throw new SlotLostError(link.errorMessage);
    }
    const view: PhysicalStatusView = {
      state: state || null,
      replayLagBytes: lag ? Number(lag) : null,
      slotActive: active === 'true',
      walStatus: walStatus || null,
      retainedBytes: retained ? Number(retained) : null,
    };
    link.lagBytes =
      view.replayLagBytes === null ? undefined : String(view.replayLagBytes);
    await this.linkRepo.save(link);
    return view;
  }

  async currentLsn(link: DbReplicationLinkEntity): Promise<string> {
    const src = await this.exec.resolve(link.srcAppId);
    const lsn = (
      await this.exec.execSql(src, 'SELECT pg_current_wal_lsn();')
    ).trim();
    if (!LSN_RE.test(lsn))
      throw new Error(`Unreadable LSN from source: ${lsn}`);
    return lsn;
  }

  /**
   * Waits until the destination has replayed `lsn`, captured after the fence.
   * A captured position, not "lag 0 at one instant", is what terminates on a
   * primary that still writes background WAL. The source must also have sent
   * it; its view of the replay position lags by up to a status interval and
   * would only lengthen the write pause.
   */
  async waitForReplay(
    link: DbReplicationLinkEntity,
    lsn: string,
    opts: { timeoutMs: number; pollMs: number },
  ): Promise<void> {
    if (!LSN_RE.test(lsn)) throw new Error(`Not an LSN: ${lsn}`);
    const names = physicalNames(link.id);
    const src = await this.exec.resolve(link.srcAppId);
    const dst = await this.exec.resolve(link.dstAppId);
    const deadline = Date.now() + opts.timeoutMs;
    for (;;) {
      const sent = (
        await this.exec.execSql(
          src,
          `SELECT coalesce((SELECT bool_or(sent_lsn >= '${lsn}'::pg_lsn)::text FROM pg_stat_replication WHERE application_name='${names.application}'),'false');`,
        )
      ).trim();
      const replayed = (
        await this.exec.execSql(
          dst,
          `SELECT coalesce((pg_last_wal_replay_lsn() >= '${lsn}'::pg_lsn)::text,'false');`,
        )
      ).trim();
      if (sent === 'true' && replayed === 'true') return;
      if (Date.now() > deadline) {
        throw new Error(
          `The destination did not replay up to ${lsn} in time (sent ${sent}, replayed ${replayed})`,
        );
      }
      await new Promise((r) => setTimeout(r, opts.pollMs));
    }
  }

  /** The point of no return. `pg_promote` must say it finished. */
  async promote(link: DbReplicationLinkEntity): Promise<void> {
    const dst = await this.exec.resolve(link.dstAppId);
    const promoted = (
      await this.exec.execSql(dst, 'SELECT pg_promote(true, 60);')
    ).trim();
    if (promoted !== 't') {
      throw new PromoteUnconfirmedError(
        `pg_promote did not confirm within 60s (returned ${promoted || 'nothing'})`,
      );
    }
    if ((await this.recoveryState(link)) !== 'primary') {
      throw new PromoteUnconfirmedError(
        'pg_promote returned but the destination still reports recovery',
      );
    }
    link.status = DbReplicationStatus.PROMOTED;
    link.lagBytes = '0';
    await this.linkRepo.save(link);
    this.logger.log(`[db-phys] link ${link.id}: destination promoted`);
  }

  /** The database is the authority on whether the point of no return has passed. */
  async recoveryState(link: DbReplicationLinkEntity): Promise<RecoveryState> {
    try {
      const dst = await this.exec.resolve(link.dstAppId);
      const out = (
        await this.exec.execSql(dst, 'SELECT pg_is_in_recovery();')
      ).trim();
      if (out === 't') return 'standby';
      if (out === 'f') return 'primary';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  async finishOnDestination(link: DbReplicationLinkEntity): Promise<void> {
    return this.teardown.finishOnDestination(link);
  }

  async finishOnSource(link: DbReplicationLinkEntity): Promise<void> {
    return this.teardown.finishOnSource(link);
  }

  async abort(link: DbReplicationLinkEntity): Promise<{ notes: string[] }> {
    return this.teardown.abort(link);
  }
}
