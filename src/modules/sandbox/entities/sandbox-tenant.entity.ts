import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum SandboxTenantState {
  /** Being built. Not offered to anyone, and reaped if it gets stuck here. */
  PROVISIONING = 'provisioning',
  /** Provisioned and warm, waiting for a visitor. */
  READY = 'ready',
  /** A visitor holds it. The countdown runs from `claimedAt`. */
  CLAIMED = 'claimed',
  /** Past its deadline, or released early. The reaper owns it now. */
  EXPIRED = 'expired',
  /** Something went wrong mid-provision or mid-reap. The sweep retries it. */
  FAILED = 'failed',
  /**
   * The same failure, over and over. Retrying it again would only rewrite the
   * same line in the log, so the row stops being swept and starts waiting for
   * a person.
   */
  NEEDS_ATTENTION = 'needs_attention',
}

/**
 * One pre-built tenancy in the reserve: a user on the IdP, a namespace with its
 * quota, and a grant that scopes the guest to what it owns.
 *
 * The reserve exists so that a click *assigns* rather than *creates* — the two
 * seconds of the landing screen are honest only because everything expensive
 * already happened. Everything here is disposable by design; the row survives
 * its tenancy only long enough for the reaper to prove it cleaned up.
 */
@Entity('sandbox_tenants')
export class SandboxTenantEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'varchar', length: 16 })
  state: SandboxTenantState;

  /** Kubernetes namespace that holds everything this guest makes. */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 63 })
  namespace: string;

  @Column({ type: 'uuid' })
  clusterId: string;

  /** Local `users` row id — the value the owner grant selects on. */
  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  @Column({ type: 'varchar', length: 255 })
  email: string;

  /** Identity-provider user id, needed to delete the account at the end. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  idpUserId: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  claimedAt: Date | null;

  /**
   * Deadline. Set at claim time, never at creation: a tenancy that waits a week
   * in the reserve must still give its visitor the full 24 hours.
   */
  @Index()
  @Column({ type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  /** Truncated claimant address, for the per-address rate limit. */
  @Index()
  @Column({ type: 'varchar', length: 64, nullable: true })
  claimIpHash: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  reapedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  /**
   * How many sweeps in a row ended in the error above. Reset the moment the
   * error changes, because a different failure means something moved.
   */
  @Column({ type: 'int', default: 0 })
  reapAttempts: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
