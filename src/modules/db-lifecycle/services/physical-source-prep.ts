import { Logger } from '@nestjs/common';
import { Repository } from 'typeorm';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { DbReplicationLinkEntity } from '../entities/db-replication-link.entity';
import { DbPodExecService, ResolvedApp } from './db-pod-exec.service';
import { DbOverlayTransportService } from './db-overlay-transport.service';
import { reloadHba } from './hba-reload';
import {
  field,
  physicalNames,
  replicationHbaScript,
} from '../utils/physical-replication.core';

const WAL_KEEP_CAP_BYTES = 2 * 1024 ** 3;
const WAL_KEEP_FLOOR_BYTES = 256 * 1024 ** 2;

/**
 * The source's side of a physical link: the per-link role and slot, the
 * `pg_hba` block for the destination's overlay address, a cap on the WAL a
 * stalled slot may pin, and the Service on the source's overlay address.
 */
export class PhysicalSourcePrep {
  constructor(
    private readonly linkRepo: Repository<DbReplicationLinkEntity>,
    private readonly encryption: EncryptionService,
    private readonly exec: DbPodExecService,
    private readonly transport: DbOverlayTransportService,
    private readonly logger: Logger,
  ) {}

  async prepare(
    link: DbReplicationLinkEntity,
    srcOverlayIp: string,
    dstOverlayIp: string,
    port: number,
  ): Promise<void> {
    const names = physicalNames(link.id);
    const src = await this.exec.resolve(link.srcAppId);
    const dst = await this.exec.resolve(link.dstAppId);
    const transport =
      link.transport?.mode === 'overlay' ? link.transport : undefined;

    const tls = await this.transport.ensureTls(src);
    const sslWasOn = transport?.sslWasOn ?? tls.sslWasOn;

    const walKeep = transport?.walKeepBefore
      ? { before: transport.walKeepBefore, set: transport.walKeepSet }
      : await this.capRetainedWal(src);
    link.transport = {
      ...transport,
      mode: 'overlay',
      sslWasOn,
      walKeepBefore: walKeep.before,
      walKeepSet: walKeep.set,
      walKeepNote: walKeep.set
        ? `max_slot_wal_keep_size was set to ${walKeep.set} on the source for this migration; the setting is cluster-wide, so it caps every replication slot there until the migration ends`
        : undefined,
    };
    await this.linkRepo.save(link);

    const password = this.encryption.decrypt(link.replRolePasswordEncrypted);
    await this.exec.execSqlStream(
      src,
      [
        `SET default_transaction_read_only = off;`,
        `DO $flui$ BEGIN`,
        `  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${names.role}') THEN`,
        `    CREATE ROLE ${names.role} WITH REPLICATION LOGIN PASSWORD '${password}';`,
        `  ELSE`,
        `    ALTER ROLE ${names.role} WITH REPLICATION LOGIN PASSWORD '${password}';`,
        `  END IF;`,
        `END $flui$;`,
        `SELECT pg_create_physical_replication_slot('${names.slot}', true) WHERE NOT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name='${names.slot}');`,
      ].join('\n'),
    );

    const out = await this.exec.execRaw(
      src,
      replicationHbaScript(names.replMarker, names.role, dstOverlayIp),
    );
    const hbaSha256Before =
      transport?.hbaSha256Before ?? field(out, 'FLUI_HBA_BEFORE');
    await reloadHba(this.exec, src);

    await this.transport.expose(src, names.service, srcOverlayIp, port);

    link.transport = {
      ...link.transport,
      mode: 'overlay',
      host: srcOverlayIp,
      port,
      svcName: names.service,
      caPath: `${dst.pvcRoot}/flui-repl-ca-${names.short}.crt`,
      dstHost: dstOverlayIp,
      hbaSha256Before,
    };
    await this.linkRepo.save(link);
    this.logger.log(
      `[db-phys] link ${link.id}: source prepared, ${srcOverlayIp}:${port} for ${dstOverlayIp}`,
    );
  }

  /**
   * Caps WAL a stalled slot may pin to a quarter of the free space on the
   * source's volume, at most 2 GiB. An operator's own cap is left alone.
   * Returns the value before, so cleanup can put it back.
   */
  private async capRetainedWal(
    src: ResolvedApp,
  ): Promise<{ before: string; set?: string }> {
    const before = (
      await this.exec.execSql(src, 'SHOW max_slot_wal_keep_size;')
    ).trim();
    if (before !== '-1') return { before };
    return { before, set: await this.setWalCap(src) };
  }

  private async setWalCap(src: ResolvedApp): Promise<string> {
    const avail = Number(
      (
        await this.exec.execRaw(
          src,
          `df -B1 --output=avail "$PGDATA" | tail -1`,
        )
      ).trim(),
    );
    const cap = Math.max(
      WAL_KEEP_FLOOR_BYTES,
      Math.min(WAL_KEEP_CAP_BYTES, Math.floor((avail || 0) * 0.25)),
    );
    const value = `${Math.floor(cap / 1024 ** 2)}MB`;
    await this.exec.execSql(
      src,
      `ALTER SYSTEM SET max_slot_wal_keep_size = '${value}';\nSELECT pg_reload_conf();`,
    );
    return value;
  }
}
