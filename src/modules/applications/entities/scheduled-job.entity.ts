import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ApplicationEntity } from './application.entity';

/** Who a schedule belongs to: a person, or the application's flui.yaml. */
export enum ScheduledJobOrigin {
  USER = 'user',
  MANIFEST = 'manifest',
}

/**
 * A schedule of an application, as Flui records it.
 *
 * The cluster's CronJob is derived from this row and rewritten from it on
 * every release and every rebuild, so a schedule outlives the cluster it ran
 * on.
 */
@Entity('scheduled_jobs')
@Index('IDX_scheduled_jobs_app_name', ['applicationId', 'name'], {
  unique: true,
})
export class ScheduledJobEntity {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_scheduled_jobs',
  })
  id: string;

  @Column('uuid')
  applicationId: string;

  @ManyToOne(() => ApplicationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'applicationId',
    foreignKeyConstraintName: 'FK_scheduled_jobs_application',
  })
  application: ApplicationEntity;

  @Column({ type: 'varchar', length: 63 })
  name: string;

  @Column({ type: 'varchar', length: 63 })
  resourceName: string;

  @Column({ type: 'varchar', length: 128 })
  schedule: string;

  @Column({ type: 'text' })
  command: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  timezone: string | null;

  @Column({ type: 'varchar', length: 16, default: 'Forbid' })
  concurrencyPolicy: string;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @Column({ type: 'varchar', length: 16, default: ScheduledJobOrigin.USER })
  origin: ScheduledJobOrigin;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
