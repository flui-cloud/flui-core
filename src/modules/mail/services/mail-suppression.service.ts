import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  mergeSuppressions,
  normaliseAddress,
  suppressionsFrom,
  type DeliveryEvent,
  type SendScope,
  type SuppressionEntry,
  type SuppressionStore,
} from '@flui-cloud/mail';
import { MailSuppressionEntity } from '../entities/mail-suppression.entity';

/**
 * The hosted side of the `SuppressionStore` seam.
 *
 * The local client reads its whole list into memory to answer a question; a
 * platform cannot, which is why the seam asks about *the addresses being
 * written to* rather than for the list. Here that becomes a `WHERE … IN`, and
 * the table can grow without the cost of asking growing with it.
 *
 * `scope` is part of the query rather than a filter applied afterwards. An
 * implementation that ignored it would hold back a password reset from someone
 * who had only left a mailing list — silently, with no error anywhere, which is
 * the exact failure this subsystem exists to prevent.
 */
@Injectable()
export class MailSuppressionService implements SuppressionStore {
  private readonly logger = new Logger(MailSuppressionService.name);

  constructor(
    @InjectRepository(MailSuppressionEntity)
    private readonly repository: Repository<MailSuppressionEntity>,
  ) {}

  async suppressed(
    addresses: readonly string[],
    scope: SendScope = 'transactional',
  ): Promise<SuppressionEntry[]> {
    const wanted = [...new Set(addresses.map(normaliseAddress))].filter(
      Boolean,
    );
    if (!wanted.length) return [];

    const rows = await this.repository.find({ where: { address: In(wanted) } });
    // A `bulk` row is invisible to transactional mail; an `all` row stops
    // everything. The asymmetry is the whole point of the column.
    return rows
      .filter((row) => row.scope === 'all' || scope === 'bulk')
      .map(toEntry);
  }

  async list(): Promise<SuppressionEntry[]> {
    const rows = await this.repository.find({
      order: { suppressedAt: 'DESC' },
    });
    return rows.map(toEntry);
  }

  /**
   * Folding on write is what keeps one row per address.
   *
   * The incoming entries are merged against what is already stored for those
   * same addresses, so recording the same bounce twice leaves one row, and a
   * later complaint replaces an earlier bounce rather than sitting beside it.
   */
  async add(entries: readonly SuppressionEntry[]): Promise<void> {
    if (!entries.length) return;
    const addresses = [
      ...new Set(entries.map((e) => normaliseAddress(e.address))),
    ];
    const existing = await this.repository.find({
      where: { address: In(addresses) },
    });
    const folded = mergeSuppressions(existing.map(toEntry), entries);

    for (const entry of folded) {
      const held = existing.find((row) => row.address === entry.address);
      await this.repository.save({
        ...(held ? { id: held.id } : {}),
        address: entry.address,
        reason: entry.reason,
        scope: entry.scope,
        suppressedAt: new Date(entry.at),
        source: entry.source ?? null,
        detail: entry.detail ?? null,
      });
    }
    this.logger.log(`Suppressed ${folded.length} address(es)`);
  }

  async remove(address: string): Promise<void> {
    // Deliberately present: a mailbox that was full in March exists again in
    // April, and a list with no way out of it eventually suppresses the
    // operator's own address.
    await this.repository.delete({ address: normaliseAddress(address) });
  }

  /**
   * Fold a batch of delivery outcomes into the list.
   *
   * `suppressionsFrom` decides what earns a suppression — a complaint always, a
   * bounce only when permanent, an unclassifiable failure never. Nothing here
   * second-guesses that: suppressing wrongly means a real person stops
   * receiving mail with no error anywhere, and a wasted retry is the cheaper
   * mistake.
   */
  async recordEvents(events: readonly DeliveryEvent[]): Promise<number> {
    const entries = suppressionsFrom(events);
    await this.add(entries);
    return entries.length;
  }
}

function toEntry(row: MailSuppressionEntity): SuppressionEntry {
  return {
    address: row.address,
    reason: row.reason,
    scope: row.scope,
    at: row.suppressedAt.toISOString(),
    ...(row.source ? { source: row.source } : {}),
    ...(row.detail ? { detail: row.detail } : {}),
  };
}
