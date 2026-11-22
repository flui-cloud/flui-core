import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { ExternalPgSource } from '../../db-lifecycle/utils/external-pg.core';

export enum DbImportStatus {
  CHECKING = 'checking',
  COPYING = 'copying',
  STREAMING = 'streaming',
  CUTTING_OVER = 'cutting-over',
  COMPLETED = 'completed',
  FAILED = 'failed',
  ABORTED = 'aborted',
}

export type DbImportEngine = 'postgres' | 'mariadb';

export const ACTIVE_IMPORT_STATUSES = [
  DbImportStatus.CHECKING,
  DbImportStatus.COPYING,
  DbImportStatus.STREAMING,
  DbImportStatus.CUTTING_OVER,
];

/** A database copied into a Flui PostgreSQL or MariaDB from one Flui does not manage. */
@Entity('db_imports')
@Index('idx_db_imports_target', ['targetApplicationId'])
export class DbImportEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  targetApplicationId: string;

  @Column({ type: 'varchar', nullable: true })
  userId: string | null;

  @Column({ type: 'varchar', length: 16, default: 'postgres' })
  engine: DbImportEngine;

  @Column({ type: 'jsonb' })
  source: ExternalPgSource;

  /** Dropped as soon as the import ends, whichever way it ends. */
  @Column({ type: 'text', nullable: true })
  sourcePasswordEncrypted: string | null;

  @Column({ type: 'varchar', length: 24, default: DbImportStatus.CHECKING })
  status: DbImportStatus;

  @Column({ type: 'varchar', length: 63 })
  objectName: string;

  /** PostgreSQL only: tables the import gave a full replica identity, put back at the end. */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  tablesWithoutKey: string[];

  @Column({ type: 'int', nullable: true })
  tablesTotal: number | null;

  @Column({ type: 'int', nullable: true })
  tablesCopied: number | null;

  @Column({ type: 'bigint', nullable: true })
  lagBytes: string | null;

  @Column({ type: 'text', nullable: true })
  detail: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  endedAt: Date | null;
}
