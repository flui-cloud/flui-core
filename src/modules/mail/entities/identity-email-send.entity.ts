import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * One message from the identity provider that was sent, by a keyed hash of its
 * recipient, kept for a day so the mail one address receives can be capped.
 * Never the address itself.
 */
@Entity('identity_email_sends')
@Index('idx_identity_email_sends_recipient', ['recipientHash', 'sentAt'])
@Index('idx_identity_email_sends_sent', ['sentAt'])
export class IdentityEmailSendEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ type: 'varchar', length: 64 })
  recipientHash: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  sentAt: Date;
}
