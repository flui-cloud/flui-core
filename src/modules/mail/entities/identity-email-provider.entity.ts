import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

export const IDENTITY_EMAIL_ROW_ID = 'identity';

export type IdentityEmailReason =
  | 'identity_provider_unreachable'
  | 'endpoint_unknown'
  | 'no_transactional_connection'
  | 'no_sender'
  | 'sender_not_ready'
  | 'sync_failed';

/**
 * The HTTP email provider Flui keeps at the identity provider, so its sign-in
 * mail leaves through Flui's own transactional sender. One row: the identity
 * provider has one active email provider per instance.
 */
@Entity('identity_email_provider')
export class IdentityEmailProviderEntity {
  @PrimaryColumn({ type: 'varchar', length: 16 })
  id: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  providerId: string | null;

  @Column({ type: 'varchar', length: 2048, nullable: true })
  endpoint: string | null;

  @Column({ type: 'text', nullable: true })
  encryptedSigningKey: string | null;

  @Column({ type: 'boolean', default: false })
  active: boolean;

  @Column({ type: 'varchar', length: 64, nullable: true })
  reason: IdentityEmailReason | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastSyncAt: Date | null;

  @Column({ type: 'text', nullable: true })
  lastSyncError: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastDeliveryAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastErrorAt: Date | null;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
