import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DbReplicationLinkEntity } from '../entities/db-replication-link.entity';
import { DbReplicationStatus } from '../enums/db-replication-status.enum';
import { DbPodExecService } from './db-pod-exec.service';

export interface ReplicationStatusView {
  linkId: string;
  status: DbReplicationStatus;
  lagBytes: number | null;
  slotActive: boolean;
  subscriptionState: string | null;
}

/** Read side of a replication link: publisher slot lag + subscriber worker
 *  state, and the exact per-table drain check the cutover gates on. */
@Injectable()
export class DbReplicationStatusService {
  constructor(
    private readonly exec: DbPodExecService,
    @InjectRepository(DbReplicationLinkEntity)
    private readonly linkRepo: Repository<DbReplicationLinkEntity>,
  ) {}

  async getLink(id: string): Promise<DbReplicationLinkEntity> {
    const link = await this.linkRepo.findOne({ where: { id } });
    if (!link) throw new NotFoundException(`Replication link ${id} not found`);
    return link;
  }

  async replicationStatus(linkId: string): Promise<ReplicationStatusView> {
    const link = await this.getLink(linkId);
    const src = await this.exec.resolve(link.srcAppId);
    const dst = await this.exec.resolve(link.dstAppId);

    // Publisher slot: lag = current WAL vs the slot's confirmed flush.
    const slotRow = await this.exec.execSql(
      src,
      `SELECT COALESCE(active::text,'f')||'|'||COALESCE(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)::text,'') FROM pg_replication_slots WHERE slot_name='${link.slotName}';`,
    );
    const [activeStr, lagStr] = slotRow.trim().split('|');
    const slotActive = activeStr === 't';
    let lagBytes: number | null = null;
    if (lagStr) lagBytes = Number(lagStr);
    else if (slotActive) lagBytes = 0;

    // Subscriber worker state.
    const subState = (
      await this.exec.execSql(
        dst,
        `SELECT COALESCE(string_agg(DISTINCT COALESCE(srsubstate,'?'),','),'') FROM pg_subscription_rel r JOIN pg_subscription s ON s.oid=r.srsubid WHERE s.subname='${link.subName}';`,
      )
    ).trim();

    // Subscription state 'r' (ready) is the reliable "initial copy done, now
    // streaming" signal; the slot's `active` flag flaps to false whenever the
    // walsender goes idle after catching up, so don't gate on it.
    const streaming = subState === 'r' && lagBytes !== null && lagBytes <= 0;
    if (
      streaming &&
      link.status !== DbReplicationStatus.PROMOTED &&
      link.status !== DbReplicationStatus.STREAMING
    ) {
      link.status = DbReplicationStatus.STREAMING;
    }
    link.lagBytes = lagBytes === null ? undefined : String(lagBytes);
    await this.linkRepo.save(link);

    return {
      linkId,
      status: link.status,
      lagBytes,
      slotActive,
      subscriptionState: subState || null,
    };
  }

  /**
   * Exact per-table count(*) on both ends of a drained link, one statement per
   * side (query_to_xml does the dynamic counting). Identifiers are rendered
   * with %I on the publisher and regclass-with-empty-search_path on the
   * subscriber so the keys compare equal.
   */
  async verifyRowCounts(
    linkId: string,
  ): Promise<{ tables: number; mismatches: string[] }> {
    const link = await this.getLink(linkId);
    const src = await this.exec.resolve(link.srcAppId);
    const dst = await this.exec.resolve(link.dstAppId);

    const srcRows = await this.exec.execSql(
      src,
      `SELECT format('%I.%I', schemaname, tablename) || '|' || COALESCE((xpath('/row/cnt/text()', query_to_xml(format('SELECT count(*) AS cnt FROM %I.%I', schemaname, tablename), false, true, '')))[1]::text, '0') FROM pg_publication_tables WHERE pubname='${link.pubName}';`,
    );
    const dstRows = await this.exec.execSql(
      dst,
      `SET search_path = '';\nSELECT r.srrelid::regclass::text || '|' || COALESCE((xpath('/row/cnt/text()', query_to_xml(format('SELECT count(*) AS cnt FROM %s', r.srrelid::regclass), false, true, '')))[1]::text, '0') FROM pg_subscription_rel r JOIN pg_subscription s ON s.oid=r.srsubid WHERE s.subname='${link.subName}';`,
    );

    const toMap = (raw: string) => {
      const m = new Map<string, string>();
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const sep = trimmed.lastIndexOf('|');
        if (sep < 0) continue;
        m.set(trimmed.slice(0, sep), trimmed.slice(sep + 1));
      }
      return m;
    };
    const srcCounts = toMap(srcRows);
    const dstCounts = toMap(dstRows);

    const mismatches: string[] = [];
    for (const [table, count] of srcCounts) {
      const dstCount = dstCounts.get(table);
      if (dstCount !== count) {
        mismatches.push(`${table}: src=${count} dst=${dstCount ?? 'missing'}`);
      }
    }
    return { tables: srcCounts.size, mismatches };
  }
}
