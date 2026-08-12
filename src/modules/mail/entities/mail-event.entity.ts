import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

/**
 * How long a delivery outcome is kept.
 *
 * Recipient addresses are other people's personal data — they belong to the
 * operator's users, not to the operator — so the window is the shortest one
 * that still answers the questions this console exists for: is mail arriving,
 * is it arriving worse than last month, and which sender broke. Thirty days
 * covers a month-over-month comparison and nothing beyond it.
 *
 * Suppressions are deliberately NOT on this clock. A do-not-send list that
 * forgets is worse than none: the address comes back into rotation and the
 * bounce that created the entry happens again.
 */
export const MAIL_EVENT_RETENTION_DAYS = 30;

export type MailEventKind =
  | 'queued'
  | 'sent'
  | 'delivered'
  | 'deferred'
  | 'bounced'
  | 'complained'
  | 'unsubscribed'
  | 'canceled';

/**
 * The current state of one message to one recipient.
 *
 * State, not history — which is why the unique constraint is on provider,
 * message and recipient rather than on an event id. Providers report what each
 * message *is* now, and the poller deliberately re-reads a window it has
 * already seen so a refusal that lands hours after the send is not missed.
 * Appending that stream would count every message several times and leave the
 * oldest verdict showing; upserting on the triple is what makes re-reading free.
 *
 * The provider is in the key because a message id is provider-assigned and
 * globally unique to nobody: Zoho returns a request id, a relay returns
 * whatever it minted. With two connections live, a collision would send the
 * upsert into another provider's row and stamp that provider's label onto this
 * provider's verdict — wrong, and invisible.
 *
 * Metadata only. The body is never carried and never stored: this is a control
 * plane for sending, not a mailbox, and the difference is what keeps it out of
 * retention obligations it has no business acquiring. `subject` is the one
 * borderline field and it is kept deliberately — without it the activity list
 * cannot tell a password reset from an invoice, which is the first thing anyone
 * asks of a failed message — and it expires on the same thirty-day sweep.
 */
@Entity('mail_events')
// Named for what it covers, provider included. The name matters beyond
// tidiness: schema sync compares constraints *by name*, so widening the columns
// under the old name leaves a database silently holding the narrower rule while
// the code inserts against the wider one — which fails at runtime, not at boot.
@Unique('uq_mail_events_provider_message_recipient', [
  'provider',
  'messageId',
  'recipient',
])
@Index('idx_mail_events_at', ['at'])
@Index('idx_mail_events_from', ['fromAddress'])
export class MailEventEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 16 })
  kind: MailEventKind;

  @Column({ type: 'varchar', length: 32 })
  provider: string;

  @Column({ type: 'varchar', length: 255 })
  messageId: string;

  /** Normalised (trimmed, lowercased), for the same reason suppressions are. */
  @Column({ type: 'varchar', length: 320 })
  recipient: string;

  /**
   * The envelope sender.
   *
   * The axis the whole console groups by: an application is recognised by the
   * address it sends from, which every provider reports, rather than by a
   * correlation id, which travels out on the message and mostly does not come
   * back. It also works for mail this platform never sent — an application
   * talking SMTP to the provider directly still shows up here.
   */
  @Column({ type: 'varchar', length: 320, nullable: true })
  fromAddress: string | null;

  @Column({ type: 'text', nullable: true })
  subject: string | null;

  /** The provider's timestamp for the current state, not ours. */
  @Column({ type: 'timestamptz' })
  at: Date;

  /** The receiving server's own words. Never rewritten, never body content. */
  @Column({ type: 'text', nullable: true })
  reason: string | null;

  /** The SMTP reply code, when reported. 5xx is permanent, 4xx is not. */
  @Column({ type: 'int', nullable: true })
  code: number | null;

  /**
   * Whether the provider itself called this failure final.
   *
   * Kept because for two of the four providers it is the *only* evidence:
   * Brevo and ZeptoMail name a hard bounce as hard and send no SMTP code at
   * all. Without it a reader of this table — or anything that ever re-folds
   * the suppression list from stored rows — is left guessing at prose.
   */
  @Column({ type: 'boolean', nullable: true })
  permanent: boolean | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
