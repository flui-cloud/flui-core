import {
  Entity,
  Index,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  BeforeInsert,
} from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { ApplicationEntity } from './application.entity';
import { ApplicationResourceKind } from '../enums/application-resource-kind.enum';
import { ApplicationResourceStatus } from '../enums/application-resource-status.enum';
import { ReconciliationStatus } from '../../infrastructure/shared/enums/reconciliation-status.enum';

@Entity('app_resources')
@Index('IDX_app_resources_application', ['applicationId'])
export class AppResourceEntity {
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

  @ManyToOne(() => ApplicationEntity, (app) => app.appResources, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'applicationId' })
  application: ApplicationEntity;

  @Column({
    type: 'enum',
    enum: ApplicationResourceKind,
  })
  kind: ApplicationResourceKind;

  @Column({ length: 255 })
  name: string;

  @Column({ length: 100 })
  namespace: string;

  @Column({ length: 255 })
  apiVersion: string;

  @Column({
    type: 'enum',
    enum: ApplicationResourceStatus,
    default: ApplicationResourceStatus.PENDING,
  })
  status: ApplicationResourceStatus;

  @Column({ length: 64, nullable: true })
  desiredHash?: string;

  @Column({ length: 64, nullable: true })
  actualHash?: string;

  @Column({ type: 'text', nullable: true })
  desiredManifest?: string;

  @Column({
    type: 'enum',
    enum: ReconciliationStatus,
    default: ReconciliationStatus.PENDING,
  })
  reconciliationStatus: ReconciliationStatus;

  @Column({ type: 'timestamptz', nullable: true })
  lastObservedAt?: Date;

  @Column({ type: 'text', nullable: true })
  errorMessage?: string;

  @Column({ type: 'json', nullable: true })
  metadata?: Record<string, string>;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
