import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

export const IDENTITY_CONSOLE_ROW_ID = 'console';

export type IdentityConsoleGateState = 'open' | 'closed';

/**
 * Whether the identity provider's own console is reachable from outside, and
 * until when. One row: closed is the absence of an open window.
 */
@Entity('identity_console_state')
export class IdentityConsoleStateEntity {
  @PrimaryColumn({ type: 'varchar', length: 16 })
  id: string;

  @Column({ type: 'timestamptz', nullable: true })
  openUntil: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  openedAt: Date | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  openedByUserId: string | null;

  @Column({ type: 'varchar', length: 320, nullable: true })
  openedByEmail: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  reason: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  closedAt: Date | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  appliedState: IdentityConsoleGateState | null;

  @Column({ type: 'jsonb', nullable: true })
  appliedHosts: string[] | null;

  @Column({ type: 'varchar', length: 2048, nullable: true })
  appliedRedirect: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  appliedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
