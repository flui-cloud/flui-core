import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomBytes } from 'node:crypto';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { DbReplicationLinkEntity } from '../entities/db-replication-link.entity';
import { DbReplicationStatus } from '../enums/db-replication-status.enum';
import { ReplicationTransport } from '../dto/replicate.dto';
import { REPL_ROLE } from '../constants';
import { DbPodExecService } from './db-pod-exec.service';
import { DbReplicationTransportService } from './db-replication-transport.service';
import {
  DbReplicationStatusService,
  ReplicationStatusView,
} from './db-replication-status.service';

/**
 * Same-cluster + cross-cluster logical-replication lifecycle (Stage 2 / MVP-3).
 * Pod-exec, external wire, and status/verify are split into sibling services;
 * this owns the state-changing primitives (fence/replicate/promote/abort).
 */
@Injectable()
export class DbReplicationService {
  private readonly logger = new Logger(DbReplicationService.name);

  constructor(
    @InjectRepository(DbReplicationLinkEntity)
    private readonly linkRepo: Repository<DbReplicationLinkEntity>,
    private readonly encryption: EncryptionService,
    private readonly exec: DbPodExecService,
    private readonly transport: DbReplicationTransportService,
    private readonly status: DbReplicationStatusService,
  ) {}

  /**
   * Soft-fence: default new transactions to read-only (existing writes drain on
   * commit). A role can override it — hard-fencing via HBA is later hardening.
   */
  async fence(appId: string): Promise<void> {
    const t = await this.exec.resolve(appId);
    await this.exec.execSql(
      t,
      `ALTER SYSTEM SET default_transaction_read_only = on;\nSELECT pg_reload_conf();`,
    );
    this.logger.log(`[db-repl] fenced app=${appId} (read-only)`);
  }

  async unfence(appId: string): Promise<void> {
    const t = await this.exec.resolve(appId);
    await this.exec.execSql(
      t,
      `ALTER SYSTEM SET default_transaction_read_only = off;\nSELECT pg_reload_conf();`,
    );
    this.logger.log(`[db-repl] unfenced app=${appId}`);
  }

  async replicateTo(
    srcAppId: string,
    dstAppId: string,
    transport: ReplicationTransport = 'auto',
  ): Promise<DbReplicationLinkEntity> {
    if (srcAppId === dstAppId) {
      throw new BadRequestException('src and dst must differ');
    }
    const src = await this.exec.resolve(srcAppId);
    const dst = await this.exec.resolve(dstAppId);
    const external =
      transport === 'external' ||
      (transport !== 'internal' && src.clusterId !== dst.clusterId);
    if (!external && src.clusterId !== dst.clusterId) {
      throw new BadRequestException(
        'internal transport requires src and dst on the same cluster',
      );
    }

    const password = randomBytes(24).toString('base64url');
    const link = await this.linkRepo.save(
      this.linkRepo.create({
        srcAppId,
        dstAppId,
        pubName: '',
        subName: '',
        slotName: '',
        replRolePasswordEncrypted: this.encryption.encrypt(password),
        status: DbReplicationStatus.INIT,
      }),
    );
    const short = link.id.replaceAll('-', '').slice(0, 12);
    const pubName = `flui_pub_${short}`;
    const subName = `flui_sub_${short}`;
    const slotName = `flui_slot_${short}`;
    // On the entity from the start so a FAILED link is still abort-cleanable.
    link.pubName = pubName;
    link.subName = subName;
    link.slotName = slotName;

    try {
      // Publisher: tables without a PK need REPLICA IDENTITY FULL or UPDATE/DELETE
      // won't replicate. Grant read for the initial copy, create the publication.
      // The session override lets this run on a fenced source — fence-first-
      // then-replicate is the zero-write-loss recipe; the fence is for apps,
      // not for the migration's own plumbing.
      await this.exec.execSql(
        src,
        [
          `SET default_transaction_read_only = off;`,
          `DO $flui$ DECLARE r record; BEGIN`,
          `  FOR r IN SELECT c.oid::regclass AS t FROM pg_class c`,
          `    JOIN pg_namespace n ON n.oid = c.relnamespace`,
          `    WHERE c.relkind='r' AND n.nspname NOT IN ('pg_catalog','information_schema')`,
          `    AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid=c.oid AND i.indisprimary)`,
          `  LOOP EXECUTE format('ALTER TABLE %s REPLICA IDENTITY FULL', r.t); END LOOP;`,
          `END $flui$;`,
          `DO $flui$ BEGIN`,
          `  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${REPL_ROLE}') THEN`,
          `    CREATE ROLE ${REPL_ROLE} WITH REPLICATION LOGIN PASSWORD '${password}';`,
          `  ELSE`,
          `    ALTER ROLE ${REPL_ROLE} WITH REPLICATION LOGIN PASSWORD '${password}';`,
          `  END IF;`,
          `END $flui$;`,
          `GRANT pg_read_all_data TO ${REPL_ROLE};`,
          `DROP PUBLICATION IF EXISTS ${pubName};`,
          `CREATE PUBLICATION ${pubName} FOR ALL TABLES;`,
        ].join('\n'),
      );

      // Logical replication copies DATA, not DDL — the destination must already
      // have the schema. Clone it (schema-only, ownerless) so replicate-to works
      // against a fresh empty install (the live-migration case).
      const schema = await this.exec.execRaw(
        src,
        `gosu postgres pg_dump --schema-only --no-owner --no-privileges --no-publications --no-subscriptions -U ${src.pgUser} -d ${src.pgDb}`,
      );
      if (schema.trim()) {
        // Streamed over stdin: a large schema would blow the kernel's per-argv
        // limit (~128KB) if passed as an exec argument.
        await this.exec.execSqlStream(dst, schema);
      }

      // Subscriber: connect back to the source (in-cluster service DNS, or the
      // TLS NodePort endpoint for cross-cluster), copy + stream.
      let conninfo = `host=${src.svcHost} port=5432 dbname=${src.pgDb} user=${REPL_ROLE} password=${password}`;
      link.transport = { mode: 'internal' };
      if (external) {
        const ext = await this.transport.prepareExternalPath(src, dst, short);
        conninfo = `host=${ext.host} port=${ext.port} dbname=${src.pgDb} user=${REPL_ROLE} password=${password} sslmode=verify-ca sslrootcert=${ext.caPath}`;
        link.transport = { mode: 'external', ...ext };
        await this.linkRepo.save(link);
      }
      await this.exec.execSql(
        dst,
        [
          `DROP SUBSCRIPTION IF EXISTS ${subName};`,
          `CREATE SUBSCRIPTION ${subName}`,
          `  CONNECTION '${conninfo}'`,
          `  PUBLICATION ${pubName}`,
          `  WITH (copy_data = true, create_slot = true, slot_name = '${slotName}');`,
        ].join('\n'),
      );

      link.status = DbReplicationStatus.COPYING;
      await this.linkRepo.save(link);
      this.logger.log(
        `[db-repl] link ${link.id}: ${srcAppId} → ${dstAppId} (copying, ${link.transport.mode})`,
      );
      return link;
    } catch (err: any) {
      link.status = DbReplicationStatus.FAILED;
      link.errorMessage = err?.message ?? String(err);
      await this.linkRepo.save(link);
      throw err;
    }
  }

  /**
   * Cut over to the destination: verify the source is fenced with no write
   * transaction still open, verify the subscription covers every published
   * table (schema drift), drain (lag→0), resync sequences (the classic
   * duplicate-PK trap), re-check lag one last time, then drop the subscription
   * so the destination is a standalone primary.
   */
  async promote(linkId: string): Promise<DbReplicationLinkEntity> {
    const link = await this.getLink(linkId);
    const src = await this.exec.resolve(link.srcAppId);
    const dst = await this.exec.resolve(link.dstAppId);

    // Fence gate: without it, a write landing between the last lag check and
    // DROP SUBSCRIPTION is silently lost. `SHOW` in a fresh session reflects
    // the reloaded system default.
    const fenced = (
      await this.exec.execSql(src, `SHOW default_transaction_read_only;`)
    ).trim();
    if (fenced !== 'on') {
      throw new BadRequestException(
        'Source is not fenced — call fence first, then retry promote',
      );
    }
    // The fence only applies to NEW transactions: a write transaction already
    // open keeps writing until it commits, invisible to the drain check below.
    const openWrites = Number(
      (
        await this.exec.execSql(
          src,
          `SELECT count(*) FROM pg_stat_activity WHERE backend_xid IS NOT NULL;`,
        )
      ).trim(),
    );
    if (openWrites > 0) {
      throw new BadRequestException(
        `Source has ${openWrites} open write transaction(s) — wait for them to finish, then retry promote`,
      );
    }

    // Schema-drift gate: FOR ALL TABLES picks up new tables on the publisher,
    // but the subscriber only syncs them after REFRESH PUBLICATION — without
    // this check a table created after replicate-to would be silently missing
    // from the promoted destination. The fence blocks further DDL, so the
    // check cannot go stale past this point.
    const published = Number(
      (
        await this.exec.execSql(
          src,
          `SELECT count(*) FROM pg_publication_tables WHERE pubname='${link.pubName}';`,
        )
      ).trim(),
    );
    const subscribed = Number(
      (
        await this.exec.execSql(
          dst,
          `SELECT count(*) FROM pg_subscription_rel r JOIN pg_subscription s ON s.oid=r.srsubid WHERE s.subname='${link.subName}';`,
        )
      ).trim(),
    );
    if (published !== subscribed) {
      throw new BadRequestException(
        `Schema drift: ${published} published tables vs ${subscribed} subscribed — call refresh on this link, wait for streaming, then retry promote`,
      );
    }

    // Drain: poll until the slot has flushed everything (lag ≤ 0).
    let drained = false;
    for (let i = 0; i < 60; i++) {
      const st = await this.status.replicationStatus(linkId);
      if (st.lagBytes !== null && st.lagBytes <= 0) {
        drained = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!drained) {
      throw new BadRequestException(
        'Replication did not drain to zero lag — is something still writing to the source?',
      );
    }

    // Sequences don't replicate — copy last_value from src to dst or the next
    // insert on dst collides with the source's ids. The statements are built
    // server-side with %L/%I so odd identifiers survive the round trip.
    const setvals = await this.exec.execSql(
      src,
      `SELECT format('SELECT setval(%L, %s);', format('%I.%I', schemaname, sequencename), last_value) FROM pg_sequences WHERE last_value IS NOT NULL;`,
    );
    const setvalCount = setvals
      .split('\n')
      .filter((l) => l.trim().length > 0).length;
    if (setvalCount > 0) {
      // setval is a write → blocked if the dst is fenced (variant-B live-fenced
      // staging). The override is a no-op on an unfenced dst (variant A).
      await this.exec.execSqlStream(
        dst,
        `SET default_transaction_read_only = off;\n${setvals}`,
      );
    }

    // Last-instant drain re-check right before detaching: catches anything a
    // fence-evading session slipped in while sequences were being resynced.
    const finalSt = await this.status.replicationStatus(linkId);
    if (finalSt.lagBytes === null || finalSt.lagBytes > 0) {
      throw new BadRequestException(
        'Source received writes during promote — re-fence and retry',
      );
    }

    // Detach the subscription (drops the remote slot when still connected).
    // DDL → override the session default in case the dst is fenced (variant B);
    // no-op on an unfenced dst (variant A).
    await this.exec.execSql(
      dst,
      [
        `SET default_transaction_read_only = off;`,
        `ALTER SUBSCRIPTION ${link.subName} DISABLE;`,
        `DROP SUBSCRIPTION IF EXISTS ${link.subName};`,
      ].join('\n'),
    );
    // Best-effort publisher cleanup. The source is fenced here — override the
    // session default or the DROP bounces off the fence silently.
    await this.exec
      .execSql(
        src,
        `SET default_transaction_read_only = off;\nDROP PUBLICATION IF EXISTS ${link.pubName};`,
      )
      .catch(() => undefined);
    await this.transport.teardownExternal(link, src);

    link.status = DbReplicationStatus.PROMOTED;
    link.lagBytes = '0';
    await this.linkRepo.save(link);
    this.logger.log(
      `[db-repl] promoted link ${link.id}: dst ${link.dstAppId} is now standalone (${setvalCount} sequences resynced)`,
    );
    return link;
  }

  /**
   * Pick up publisher-side schema drift: clone the schema of published tables
   * the subscriber doesn't have yet, then REFRESH PUBLICATION so their initial
   * copy starts. Status drops back to copying until every table is ready.
   */
  async refresh(linkId: string): Promise<DbReplicationLinkEntity> {
    const link = await this.getLink(linkId);
    if (!link.subName) {
      throw new BadRequestException('Link has no subscription to refresh');
    }
    const src = await this.exec.resolve(link.srcAppId);
    const dst = await this.exec.resolve(link.dstAppId);

    // Quoted identifiers on both sides so the set-difference is exact.
    const publishedRaw = await this.exec.execSql(
      src,
      `SELECT format('%I.%I', schemaname, tablename) FROM pg_publication_tables WHERE pubname='${link.pubName}';`,
    );
    const presentRaw = await this.exec.execSql(
      dst,
      `SELECT format('%I.%I', schemaname, tablename) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema');`,
    );
    const present = new Set(
      presentRaw
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    );
    const missing = publishedRaw
      .split('\n')
      .map((l) => l.trim())
      .filter((t) => t && !present.has(t));

    if (missing.length > 0) {
      const tableFlags = missing.map((t) => `-t '${t}'`).join(' ');
      const schema = await this.exec.execRaw(
        src,
        `gosu postgres pg_dump --schema-only --no-owner --no-privileges --no-publications --no-subscriptions ${tableFlags} -U ${src.pgUser} -d ${src.pgDb}`,
      );
      if (schema.trim()) {
        // The dst may be fenced (variant-B live-fenced staging): a CREATE TABLE
        // bounces off the read-only default without a session override. No-op on
        // an unfenced dst (variant A).
        await this.exec.execSqlStream(
          dst,
          `SET default_transaction_read_only = off;\n${schema}`,
        );
      }
    }

    await this.exec.execSql(
      dst,
      `SET default_transaction_read_only = off;\nALTER SUBSCRIPTION ${link.subName} REFRESH PUBLICATION;`,
    );
    link.status = DbReplicationStatus.COPYING;
    await this.linkRepo.save(link);
    this.logger.log(
      `[db-repl] refreshed link ${link.id}: ${missing.length} new table(s) syncing`,
    );
    return link;
  }

  /**
   * Tear a link down without promoting. The critical half is the publisher
   * slot: left behind, it pins WAL forever and eventually fills the source
   * disk. Every step is best-effort so a half-dead pair can still be cleaned.
   */
  async abort(linkId: string): Promise<DbReplicationLinkEntity> {
    const link = await this.getLink(linkId);
    if (link.status === DbReplicationStatus.PROMOTED) {
      throw new BadRequestException('Link already promoted — nothing to abort');
    }

    // Subscriber side: detach the slot before dropping so the DROP never
    // blocks on an unreachable publisher.
    if (link.subName) {
      const dst = await this.exec.resolve(link.dstAppId).catch(() => null);
      if (dst) {
        // Override the session default so these DDLs don't bounce off a dst
        // fence (variant-B live-fenced staging); no-op on an unfenced dst.
        const unfenced = 'SET default_transaction_read_only = off;\n';
        await this.exec
          .execSql(
            dst,
            `${unfenced}ALTER SUBSCRIPTION ${link.subName} DISABLE;`,
          )
          .catch(() => undefined);
        await this.exec
          .execSql(
            dst,
            `${unfenced}ALTER SUBSCRIPTION ${link.subName} SET (slot_name = NONE);`,
          )
          .catch(() => undefined);
        await this.exec
          .execSql(
            dst,
            `${unfenced}DROP SUBSCRIPTION IF EXISTS ${link.subName};`,
          )
          .catch(() => undefined);
      }
    }

    // Publisher side: the slot is inactive once the subscriber detached (or
    // died); dropping it releases the retained WAL.
    const src = await this.exec.resolve(link.srcAppId).catch(() => null);
    if (src) {
      if (link.slotName) {
        await this.exec
          .execSql(
            src,
            `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name='${link.slotName}' AND NOT active;`,
          )
          .catch((err) =>
            this.logger.warn(
              `[db-repl] abort ${linkId}: slot ${link.slotName} not dropped (${err?.message}) — WAL stays pinned until it is`,
            ),
          );
      }
      if (link.pubName) {
        // Session override: an aborted link often leaves the source fenced.
        await this.exec
          .execSql(
            src,
            `SET default_transaction_read_only = off;\nDROP PUBLICATION IF EXISTS ${link.pubName};`,
          )
          .catch(() => undefined);
      }
      await this.transport.teardownExternal(link, src);
    }

    link.status = DbReplicationStatus.ABORTED;
    await this.linkRepo.save(link);
    this.logger.log(`[db-repl] aborted link ${link.id}`);
    return link;
  }

  async getLink(id: string): Promise<DbReplicationLinkEntity> {
    return this.status.getLink(id);
  }

  replicationStatus(linkId: string): Promise<ReplicationStatusView> {
    return this.status.replicationStatus(linkId);
  }

  verifyRowCounts(
    linkId: string,
  ): Promise<{ tables: number; mismatches: string[] }> {
    return this.status.verifyRowCounts(linkId);
  }

  /**
   * The fence only stops NEW transactions — a write transaction already open
   * keeps writing until it commits. Terminate every session holding an xid so
   * the cutover write-pause is bounded (walsenders and idle sessions hold none).
   */
  async terminateWriters(appId: string): Promise<number> {
    const t = await this.exec.resolve(appId);
    const out = await this.exec.execSql(
      t,
      `SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE backend_xid IS NOT NULL AND pid <> pg_backend_pid();`,
    );
    const n = Number(out.trim()) || 0;
    if (n > 0) {
      this.logger.log(
        `[db-repl] terminated ${n} in-flight write transaction(s) on app=${appId}`,
      );
    }
    return n;
  }
}
