import {
  Entity,
  Index,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  BeforeInsert,
} from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { ApplicationEntity } from './application.entity';
import { ApplicationStatus } from '../enums/application-status.enum';
import {
  ApplicationSourceConfig,
  ApplicationEnvVar,
  ApplicationResources,
} from '../interfaces/source-config.interface';
import { AppEventType, AppEventActor } from '../enums/app-event-type.enum';

@Entity('app_revisions')
@Index('IDX_app_revisions_application_created', ['applicationId', 'createdAt'])
export class AppRevisionEntity {
  @PrimaryColumn('uuid')
  id: string;

  @BeforeInsert()
  generateId() {
    if (!this.id) {
      this.id = uuidv4();
    }
  }

  @Column('uuid')
  applicationId: string;

  @ManyToOne(() => ApplicationEntity, (app) => app.revisions, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'applicationId' })
  application: ApplicationEntity;

  @Column({
    type: 'enum',
    enum: AppEventType,
    default: AppEventType.DEPLOY,
  })
  eventType: AppEventType;

  // Actor who triggered the event. Nullable for legacy rows and system-internal ops.
  @Column({ type: 'json', nullable: true })
  actor: AppEventActor | null;

  // Structured diff/context for the event. Shape varies by eventType (see AppEventType).
  @Column({ type: 'json', default: '{}' })
  changeMetadata: Record<string, unknown>;

  // Incremental revision number — set only for DEPLOY and ROLLBACK events.
  // Null for operational events (SCALE, RESTART, etc.).
  @Column({ type: 'int', nullable: true })
  revisionNumber: number | null;

  @Column({ length: 255, nullable: true })
  imageRef?: string;

  @Column({ length: 255, nullable: true })
  commitSha?: string;

  @Column({ length: 255, nullable: true })
  chartVersion?: string;

  @Column({ type: 'json', default: '{}' })
  sourceConfigSnapshot: ApplicationSourceConfig;

  @Column({ type: 'json', default: '[]' })
  envSnapshot: ApplicationEnvVar[];

  @Column({ type: 'json', default: '{}' })
  resourcesSnapshot: ApplicationResources;

  @Column({ type: 'int', nullable: true })
  replicas?: number;

  @Column({
    type: 'enum',
    enum: ApplicationStatus,
    default: ApplicationStatus.PENDING,
  })
  status: ApplicationStatus;

  @Column({ type: 'text', nullable: true })
  errorMessage?: string;

  @Column({ nullable: true })
  deployedBy?: string;

  @Column({ nullable: true })
  operationId?: string;

  @Column({ type: 'uuid', nullable: true })
  buildId: string | null;

  @Column({ type: 'json', default: '{}' })
  k8sResourceHashes: Record<string, string>;

  @Column({ type: 'text', nullable: true })
  rollbackReason?: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
