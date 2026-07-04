import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { DbReplicationStatus } from '../enums/db-replication-status.enum';

export interface DbReplicationTransportInfo {
  mode: 'internal' | 'external';
  host?: string;
  port?: number;
  svcName?: string;
  caPath?: string;
}

/**
 * One logical-replication link between two Postgres installs (same cluster in
 * Stage 2). Holds the publication/subscription/slot names + the replication
 * role password so status/promote can act idempotently, and is the state the
 * future live-migration state machine (MVP-5) drives.
 */
@Entity('db_replication_links')
@Index('idx_db_repl_links_src', ['srcAppId'])
@Index('idx_db_repl_links_dst', ['dstAppId'])
export class DbReplicationLinkEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  srcAppId: string;

  @Column({ type: 'uuid' })
  dstAppId: string;

  @Column({ length: 64 })
  pubName: string;

  @Column({ length: 64 })
  subName: string;

  @Column({ length: 64 })
  slotName: string;

  @Column({ type: 'text' })
  replRolePasswordEncrypted: string;

  /** Wire path — external links carry the NodePort endpoint so promote/abort
   *  can tear it down. */
  @Column({ type: 'jsonb', nullable: true })
  transport?: DbReplicationTransportInfo;

  @Column({
    type: 'enum',
    enum: DbReplicationStatus,
    default: DbReplicationStatus.INIT,
  })
  status: DbReplicationStatus;

  @Column({ type: 'bigint', nullable: true })
  lagBytes?: string;

  @Column({ type: 'text', nullable: true })
  errorMessage?: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
