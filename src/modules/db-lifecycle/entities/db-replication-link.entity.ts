import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import {
  DbReplicationKind,
  DbReplicationStatus,
} from '../enums/db-replication-status.enum';

export interface DbReplicationTransportInfo {
  mode: 'internal' | 'external' | 'overlay';
  host?: string;
  port?: number;
  svcName?: string;
  caPath?: string;
  /** Overlay: the destination's egress policy for this link. */
  netpolName?: string;
  /** Overlay: the destination node's overlay address `pg_hba` admits. */
  dstHost?: string;
  /** Overlay: whether the source had TLS on before Flui touched it. */
  sslWasOn?: boolean;
  /** Overlay: `pg_hba.conf` checksum before the replication block. */
  hbaSha256Before?: string;
  /** Overlay: `max_slot_wal_keep_size` before Flui capped it. */
  walKeepBefore?: string;
  /** Overlay: the cap Flui set on the source, when it set one. */
  walKeepSet?: string;
  /** Overlay: says the cap is cluster-wide on the source, for the views. */
  walKeepNote?: string;
  warnings?: string[];
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

  @Column({
    type: 'varchar',
    length: 16,
    default: DbReplicationKind.LOGICAL,
  })
  kind: DbReplicationKind;

  @Column({ type: 'uuid', nullable: true })
  wgLinkId?: string | null;

  /** Physical: the per-link replication role on the source. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  replRole?: string | null;

  @Column({ type: 'uuid', nullable: true })
  srcNodeId?: string | null;

  @Column({ type: 'uuid', nullable: true })
  dstNodeId?: string | null;

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
