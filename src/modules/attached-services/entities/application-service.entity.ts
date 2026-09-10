import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { LinkedEnvSpec } from '../attached-service-env.core';

export enum AttachedServiceStatus {
  PENDING = 'PENDING',
  PROVISIONING = 'PROVISIONING',
  READY = 'READY',
  FAILED = 'FAILED',
  DETACHED = 'DETACHED',
}

/**
 * The lifetime an attached service shares.
 *
 * Only `app` exists — one instance per application, born and removed with it.
 * The column is here because it is the one fact a later `scope: project` would
 * have to distinguish, and adding it to rows that already exist is the hard
 * half. The manifest spec (0.10.0) has no `scope` field, so nothing can write
 * anything else today, and no code branches on it.
 */
export type AttachedServiceScope = 'app';

/**
 * One building block an application declared in `deploy.services[]`, and what
 * became of it.
 *
 * A table rather than a key in `application.metadata`, for two measured
 * reasons: the source-deploy path merges metadata blindly
 * (`{ ...app.metadata, ...manifestMetadata }`) so any writer would silently
 * drop an attachment record, and an orphan sweep needs an index, which a JSON
 * blob does not give.
 *
 * `catalogInstallId` is unique on purpose: it is what makes it impossible, in
 * the database rather than in a code path, for two applications to claim the
 * same Postgres.
 */
@Entity('application_services')
@Index('IDX_application_services_app_name', ['applicationId', 'name'], {
  unique: true,
  where: '"deletedAt" IS NULL',
})
export class ApplicationServiceEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** The application that declared it — the consumer, never the block. */
  @Index('IDX_application_services_app')
  @Column('uuid')
  applicationId: string;

  /** `deploy.services[].name`, unique within the application. */
  @Column({ type: 'varchar', length: 32 })
  name: string;

  /** Catalog slug of the building block. */
  @Column({ type: 'varchar', length: 64 })
  block: string;

  @Column({ type: 'varchar', length: 16, default: 'app' })
  scope: AttachedServiceScope;

  /** The catalog install that provisioned it, once it exists. */
  @Index('IDX_application_services_install', { unique: true })
  @Column({ type: 'uuid', nullable: true })
  catalogInstallId: string | null;

  /** The block's own application row — what the removal cascade and the console need. */
  @Index('IDX_application_services_block_app')
  @Column({ type: 'uuid', nullable: true })
  bbApplicationId: string | null;

  @Index('IDX_application_services_status')
  @Column({
    type: 'varchar',
    length: 16,
    default: AttachedServiceStatus.PENDING,
  })
  status: AttachedServiceStatus;

  @Column({ type: 'text', nullable: true })
  statusReason: string | null;

  /** `deploy.services[].env` verbatim — what the wiring is re-derived from. */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  envSpec: LinkedEnvSpec[];

  /** `deploy.services[].resources`, passed to the block install. */
  @Column({ type: 'jsonb', nullable: true })
  resources: Record<string, unknown> | null;

  /** sha256 of {block, envSpec, resources} — the only definition of "must reconcile". */
  @Column({ type: 'varchar', length: 64, default: '' })
  desiredHash: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  appliedHash: string | null;

  /**
   * Held while one worker provisions this row. An expiry rather than a
   * transaction because an install takes minutes, and rather than an in-process
   * mutex because two API replicas would each hold their own.
   */
  @Column({ type: 'uuid', nullable: true })
  lockToken: string | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  lockExpiresAt: Date | null;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt: Date;

  @DeleteDateColumn({ type: 'timestamp with time zone', nullable: true })
  deletedAt: Date | null;
}
