import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  Unique,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { ApplicationEntity } from '../../applications/entities/application.entity';

export type AlertEventStatus = 'firing' | 'resolved';

/** `alertmanager` when the resolve notification arrived, `timeout` when it never did. */
export type AlertEventResolvedBy = 'alertmanager' | 'timeout';

/**
 * One episode of one alert.
 *
 * Alertmanager owns evaluation, grouping and silencing; this table is the record of
 * what it told us, so the dashboard can show what happened while nobody was looking
 * and delivery has a transition to react to.
 *
 * Identity is `(fingerprint, startsAt)`. The fingerprint hashes the label set — stable
 * across the repeats Alertmanager sends every `repeat_interval`, but reused when the
 * same alert fires again later, so it cannot identify a row on its own. `startsAt` is
 * constant for the whole episode and delimits it: a repeat updates the row in place, a
 * second episode gets a new one.
 */
@Entity('alert_events')
@Unique('uq_alert_events_fingerprint_starts_at', ['fingerprint', 'startsAt'])
@Index('idx_alert_events_status_last_seen', ['status', 'lastSeenAt'])
@Index('idx_alert_events_application_starts_at', ['applicationId', 'startsAt'])
@Index('idx_alert_events_cluster_starts_at', ['clusterId', 'startsAt'])
export class AlertEventEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 64 })
  fingerprint: string;

  @Column({ type: 'timestamptz' })
  startsAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  endsAt?: Date | null;

  /** Refreshed on every repeat; how a firing row that stopped repeating is spotted. */
  @Column({ type: 'timestamptz' })
  lastSeenAt: Date;

  // varchar rather than a Postgres enum on purpose: user-defined alert rules are on the
  // roadmap and severity is whatever a rule file says, so an enum would mean a migration
  // every time the vocabulary grows. Status follows the same shape for symmetry.
  @Column({ length: 16 })
  status: AlertEventStatus;

  @Column({ length: 16, nullable: true })
  resolvedBy?: AlertEventResolvedBy | null;

  @Column({ length: 128 })
  alertname: string;

  @Column({ length: 32 })
  severity: string;

  /** `application` | `traffic` | `node`, as stamped by the rule. */
  @Column({ length: 32, nullable: true })
  fluiKind?: string | null;

  @Column({ type: 'uuid', nullable: true })
  clusterId?: string | null;

  @Column({ type: 'uuid', nullable: true })
  applicationId?: string | null;

  @ManyToOne(() => ApplicationEntity, { onDelete: 'SET NULL', nullable: true })
  // Named explicitly to match the migration; left implicit, TypeORM derives a hashed
  // name and every future migration:generate proposes renaming the constraint.
  @JoinColumn({
    name: 'applicationId',
    foreignKeyConstraintName: 'fk_alert_events_application',
  })
  application?: ApplicationEntity | null;

  // Denormalized so the history of a deleted application still reads as something
  // other than a row of nulls.
  @Column({ length: 253, nullable: true })
  applicationSlug?: string | null;

  @Column({ length: 253, nullable: true })
  namespace?: string | null;

  @Column({ length: 253, nullable: true })
  nodeInstance?: string | null;

  @Column({ type: 'jsonb', default: {} })
  labels: Record<string, string>;

  // Overwritten on every repeat: annotations are templated, so "12% of requests are
  // failing" is only true for the notification that carried it.
  @Column({ type: 'jsonb', default: {} })
  annotations: Record<string, string>;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
