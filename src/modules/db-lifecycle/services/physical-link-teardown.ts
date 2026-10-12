import { BadRequestException, Logger } from '@nestjs/common';
import { Repository } from 'typeorm';
import { WireGuardLinkService } from '../../infrastructure/networking/services/wireguard-link.service';
import { DbReplicationLinkEntity } from '../entities/db-replication-link.entity';
import { DbReplicationStatus } from '../enums/db-replication-status.enum';
import { DbPodExecService, ResolvedApp } from './db-pod-exec.service';
import {
  DbOverlayTransportService,
  STANDBY_DIR,
} from './db-overlay-transport.service';
import { reloadHba } from './hba-reload';
import {
  PROMOTED_HBA_CLEANUP_SCRIPT,
  RecoveryState,
  field,
  physicalNames,
  promotedSettingsResetSql,
  removeHbaBlockScript,
} from '../utils/physical-replication.core';

const SLOT_DROP_ATTEMPTS = 10;

/** The end of a physical link: cleanup after promote, or an abort without one. */
export class PhysicalLinkTeardown {
  constructor(
    private readonly linkRepo: Repository<DbReplicationLinkEntity>,
    private readonly exec: DbPodExecService,
    private readonly transport: DbOverlayTransportService,
    private readonly wgLinks: WireGuardLinkService,
    private readonly logger: Logger,
    private readonly recoveryState: (
      link: DbReplicationLinkEntity,
    ) => Promise<RecoveryState>,
  ) {}

  /** Forward-only cleanup on the promoted destination. */
  async finishOnDestination(link: DbReplicationLinkEntity): Promise<void> {
    const names = physicalNames(link.id);
    const dst = await this.exec.resolve(link.dstAppId);
    await this.exec.execSql(
      dst,
      promotedSettingsResetSql(link.transport?.sslWasOn === false),
    );
    await this.exec.execSql(
      dst,
      [
        `DROP ROLE IF EXISTS ${names.role};`,
        `DO $flui$ DECLARE p record; BEGIN`,
        String.raw`  FOR p IN SELECT pubname FROM pg_publication WHERE pubname LIKE 'flui\_pub\_%' LOOP`,
        `    EXECUTE format('DROP PUBLICATION IF EXISTS %I', p.pubname);`,
        `  END LOOP;`,
        `END $flui$;`,
      ].join('\n'),
    );
    await this.exec.execRaw(dst, PROMOTED_HBA_CLEANUP_SCRIPT);
    await reloadHba(this.exec, dst);
    await this.exec.execRaw(
      dst,
      `rm -f ${dst.pvcRoot}/${STANDBY_DIR}/conninfo ${dst.pvcRoot}/${STANDBY_DIR}/slot`,
    );
  }

  /**
   * Cleanup on the source after promote. The fence block stays: the source is
   * left fenced for good.
   */
  async finishOnSource(link: DbReplicationLinkEntity): Promise<void> {
    const src = await this.exec.resolve(link.srcAppId);
    await this.dropSlot(link, src);
    await this.unprepareSource(link, src, false);
    await this.closeTransport(link, src);
  }

  /**
   * Tears the link down without promoting. The slot goes first, because it
   * pins WAL on the source; then the destination stops dialling; then the
   * rest. Every step is best-effort so a half-dead pair can still be cleaned.
   */
  async abort(link: DbReplicationLinkEntity): Promise<{ notes: string[] }> {
    if (link.status === DbReplicationStatus.PROMOTED) {
      throw new BadRequestException('Link already promoted — nothing to abort');
    }
    const notes: string[] = [];
    const src = await this.exec.resolve(link.srcAppId).catch(() => null);
    if (src) {
      await this.dropSlot(link, src).catch((err) =>
        notes.push(`slot not dropped: ${err?.message}`),
      );
    }

    const dst = await this.exec.resolve(link.dstAppId).catch(() => null);
    if (dst) {
      await this.exec
        .execRaw(
          dst,
          `mkdir -p ${dst.pvcRoot}/${STANDBY_DIR} && touch ${dst.pvcRoot}/${STANDBY_DIR}/aborted && rm -f ${dst.pvcRoot}/${STANDBY_DIR}/conninfo`,
        )
        .catch((err) =>
          notes.push(`destination not told to stop: ${err?.message}`),
        );
      if ((await this.recoveryState(link)) === 'standby') {
        await this.exec
          .execSql(
            dst,
            'ALTER SYSTEM RESET primary_conninfo;\nSELECT pg_reload_conf();',
          )
          .catch((err) =>
            notes.push(`standby still points at the source: ${err?.message}`),
          );
      }
    }

    if (src) {
      const note = await this.unprepareSource(link, src, true).catch(
        (err) => `source not fully restored: ${err?.message}`,
      );
      if (note) notes.push(note);
    }
    await this.closeTransport(link, src).catch((err) =>
      notes.push(`transport not withdrawn: ${err?.message}`),
    );

    link.status = DbReplicationStatus.ABORTED;
    if (notes.length) link.errorMessage = notes.join('; ');
    await this.linkRepo.save(link);
    const detail = notes.length ? ` (${notes.join('; ')})` : '';
    this.logger.log(`[db-phys] aborted link ${link.id}${detail}`);
    return { notes };
  }

  private async dropSlot(
    link: DbReplicationLinkEntity,
    src: ResolvedApp,
  ): Promise<void> {
    const names = physicalNames(link.id);
    for (let i = 0; i < SLOT_DROP_ATTEMPTS; i++) {
      await this.exec.execSql(
        src,
        `SELECT count(pg_terminate_backend(pid)) FROM pg_stat_replication WHERE application_name='${names.application}';`,
      );
      const left = (
        await this.exec.execSql(
          src,
          `SELECT count(pg_drop_replication_slot(slot_name)) FROM pg_replication_slots WHERE slot_name='${names.slot}' AND NOT active;\nSELECT count(*) FROM pg_replication_slots WHERE slot_name='${names.slot}';`,
        )
      )
        .trim()
        .split('\n')
        .pop()
        ?.trim();
      if (left === '0') return;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(
      `slot ${names.slot} is still active on the source — WAL stays pinned until it is dropped`,
    );
  }

  /** Returns a note when the file was edited by someone else meanwhile. */
  private async unprepareSource(
    link: DbReplicationLinkEntity,
    src: ResolvedApp,
    compareChecksum: boolean,
  ): Promise<string | undefined> {
    const names = physicalNames(link.id);
    const t = link.transport;
    await this.exec.execSql(
      src,
      `SET default_transaction_read_only = off;\nDROP ROLE IF EXISTS ${names.role};`,
    );
    await this.exec.execRaw(src, removeHbaBlockScript(names.fwdMarker));
    const out = await this.exec.execRaw(
      src,
      removeHbaBlockScript(names.replMarker),
    );
    await reloadHba(this.exec, src);
    const reset: string[] = [];
    if (t?.sslWasOn === false) {
      reset.push(
        'ALTER SYSTEM RESET ssl;',
        'ALTER SYSTEM RESET ssl_cert_file;',
        'ALTER SYSTEM RESET ssl_key_file;',
      );
    }
    if (t?.walKeepBefore === '-1') {
      reset.push('ALTER SYSTEM RESET max_slot_wal_keep_size;');
    }
    if (reset.length) {
      await this.exec.execSql(
        src,
        [...reset, 'SELECT pg_reload_conf();'].join('\n'),
      );
    }
    const after = field(out, 'FLUI_HBA_AFTER');
    if (compareChecksum && t?.hbaSha256Before && after !== t.hbaSha256Before) {
      return `pg_hba.conf of the source changed while the link was open (now ${after ?? 'unknown'}); only the replication block was removed`;
    }
    return undefined;
  }

  private async closeTransport(
    link: DbReplicationLinkEntity,
    src: ResolvedApp | null,
  ): Promise<void> {
    const dst = await this.exec.resolve(link.dstAppId).catch(() => null);
    await this.transport.withdraw(src, dst, {
      svcName: link.transport?.svcName,
      netpolName: link.transport?.netpolName,
    });
    await this.transport.withdraw(null, dst, {
      netpolName: physicalNames(link.id).fwdNetpol,
    });
    if (link.wgLinkId) {
      await this.wgLinks.close(link.wgLinkId, 'replication finished');
    }
  }
}
