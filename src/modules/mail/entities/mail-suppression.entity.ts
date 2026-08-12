import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

export type MailSuppressionReason =
  | 'bounce'
  | 'complaint'
  | 'unsubscribe'
  | 'manual';

/**
 * `all` reaches every message; `bulk` stops one-to-many mail only.
 *
 * The distinction is the reason this table is not a flat do-not-send list. A
 * mailbox that does not exist is not selectively absent, so a permanent bounce
 * is `all`. Someone leaving a mailing list is still waiting for the password
 * reset they requested thirty seconds ago, so an unsubscribe is `bulk`.
 */
export type MailSuppressionScope = 'all' | 'bulk';

/**
 * Addresses we have stopped writing to, and how far the stop reaches.
 *
 * One row per address rather than an append-only log: the question asked of
 * this table is always "may I write to this person right now", and a history of
 * every refusal answers it slower and no better. The fold happens on write —
 * the strongest reason wins, and among equals the earliest, so the row says
 * when sending stopped rather than restating the latest retry.
 *
 * Addresses are stored normalised (trimmed, lowercased). The local part of an
 * address is formally case-sensitive and no mail system in service treats it
 * that way; comparing raw would let `User@example.com` slip past a suppression
 * created for `user@example.com`, which is not a near miss but a full retry
 * against an address already known to be dead.
 */
@Entity('mail_suppressions')
@Unique('uq_mail_suppressions_address', ['address'])
@Index('idx_mail_suppressions_scope', ['scope'])
export class MailSuppressionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Normalised on the way in. Never write a raw address here. */
  @Column({ type: 'varchar', length: 320 })
  address: string;

  @Column({ type: 'varchar', length: 16 })
  reason: MailSuppressionReason;

  @Column({ type: 'varchar', length: 8, default: 'all' })
  scope: MailSuppressionScope;

  /** When sending stopped — the provider's timestamp, not ours. */
  @Column({ type: 'timestamptz' })
  suppressedAt: Date;

  @Column({ type: 'varchar', length: 64, nullable: true })
  source: string | null;

  /** The provider's own words. Never body content. */
  @Column({ type: 'text', nullable: true })
  detail: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
