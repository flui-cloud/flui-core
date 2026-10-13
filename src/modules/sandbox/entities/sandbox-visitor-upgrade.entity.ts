import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export const VISITOR_UPGRADE_METHOD = {
  IDP: 'idp',
  EMAIL: 'email',
} as const;

export type VisitorUpgradeMethod =
  (typeof VISITOR_UPGRADE_METHOD)[keyof typeof VISITOR_UPGRADE_METHOD];

/**
 * A visitor's sign-in under way, bound to that visitor: a GitHub or Google
 * sign-in started for it, or the email link it carries through registration.
 * Secrets are kept only as hashes, the provider's intent token only encrypted,
 * and each one is claimed once.
 */
@Entity('sandbox_visitor_upgrades')
@Index('IDX_sandbox_visitor_upgrades_secret', ['secretHash'], {
  unique: true,
  where: '"secretHash" IS NOT NULL',
})
@Index('IDX_sandbox_visitor_upgrades_intent', ['intentId'], {
  unique: true,
  where: '"intentId" IS NOT NULL',
})
export class SandboxVisitorUpgradeEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  visitorUserId: string;

  @Column({ type: 'varchar', length: 8 })
  method: VisitorUpgradeMethod;

  @Column({ type: 'varchar', length: 16, nullable: true })
  provider: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  idpId: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  intentId: string | null;

  @Column({ type: 'text', nullable: true })
  intentTokenEncrypted: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  secretHash: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  returnTo: string | null;

  @Index('IDX_sandbox_visitor_upgrades_expires')
  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  claimedAt: Date | null;

  @Column({ type: 'varchar', length: 24, nullable: true })
  outcome: string | null;

  @Column({ type: 'uuid', nullable: true })
  linkedUserId: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
