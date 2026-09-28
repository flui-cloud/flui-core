import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * `admins` is not a destination somebody adds: it is the one row that holds
 * how far the built-in administrator email reaches, and there is at most one.
 */
export type AlertDestinationKind = 'email' | 'webhook' | 'admins';

export type AlertSeverityFloor = 'warning' | 'critical';

/**
 * `infrastructure` hears only what no application owns (nodes, disks,
 * certificates, platform backups); `all` hears every tenant's alerts as well,
 * which is reading their data and needs `data:access` to set.
 */
export type AlertDestinationScope = 'infrastructure' | 'all';

/**
 * Somewhere an alert goes besides the bell and the built-in email: an address
 * or a signed webhook, each with the least severity it wants to hear about.
 */
@Entity('alert_destinations')
@Index('IDX_alert_destinations_admins', ['kind'], {
  unique: true,
  where: `"kind" = 'admins'`,
})
export class AlertDestinationEntity {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_alert_destinations',
  })
  id: string;

  @Column({ type: 'varchar', length: 16 })
  kind: AlertDestinationKind;

  @Column({ type: 'varchar', length: 2048, nullable: true })
  target: string | null;

  @Column({ type: 'varchar', length: 16, default: 'critical' })
  minSeverity: AlertSeverityFloor;

  @Column({ type: 'varchar', length: 16, default: 'infrastructure' })
  scope: AlertDestinationScope;

  @Column({ type: 'text', nullable: true })
  secretEncrypted: string | null;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @Column({ type: 'varchar', length: 320, nullable: true })
  createdBy: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  lastDeliveryAt: Date | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  lastStatus: string | null;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;
}
