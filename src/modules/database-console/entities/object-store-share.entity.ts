import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

/**
 * Registry of object-store share links. The link itself stays stateless and
 * HMAC-signed (see {@link ObjectStoreShareService}); this row exists ONLY to add
 * what a stateless presigned URL can't do: revocation + visibility + a
 * best-effort last-accessed timestamp. The raw token is never stored — only its
 * sha256 (`tokenId`), so the row can be correlated on access without holding the
 * credential. Absence of a row means "not tracked" (allowed if crypto-valid).
 */
@Entity('object_store_shares')
export class ObjectStoreShareEntity {
  @PrimaryColumn('uuid')
  id: string;

  @BeforeInsert()
  generateId() {
    if (!this.id) {
      this.id = uuidv4();
    }
  }

  /** sha256(token) hex — lookup key on the public access path. */
  @Index({ unique: true })
  @Column({ length: 64 })
  tokenId: string;

  @Index()
  @Column('uuid')
  appId: string;

  @Column({ length: 63 })
  bucket: string;

  @Column({ type: 'text' })
  objectKey: string;

  /** User who minted the link (audit + per-user listing). */
  @Column('uuid', { nullable: true })
  ownerUserId: string | null;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastAccessedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
