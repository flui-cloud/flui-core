import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

export type IdentityEmailDeliveryState = 'sending' | 'sent';

/**
 * One message from the identity provider, by a keyed hash of its body, kept
 * for a short window so a retry of a message already sent is not sent twice.
 * Never the body: it carries sign-in codes.
 */
@Entity('identity_email_deliveries')
@Index('idx_identity_email_deliveries_updated', ['updatedAt'])
export class IdentityEmailDeliveryEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  bodyHash: string;

  @Column({ type: 'varchar', length: 16 })
  state: IdentityEmailDeliveryState;

  @Column({ type: 'int', default: 0 })
  duplicates: number;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  updatedAt: Date;
}
