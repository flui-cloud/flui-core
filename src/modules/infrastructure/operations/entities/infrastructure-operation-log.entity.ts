import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  BeforeInsert,
  Index,
} from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

/**
 * One row per operation, appended to rather than replaced. A `json`/`jsonb`
 * column would reparse the whole growing blob on every tail tick; plain
 * `text` lets the append happen at the SQL level (`content || :chunk`).
 */
@Entity('infrastructure_operation_logs')
export class InfrastructureOperationLogEntity {
  @PrimaryColumn('uuid')
  id: string;

  @BeforeInsert()
  generateId() {
    if (!this.id) {
      this.id = uuidv4();
    }
  }

  // Named explicitly (repo convention, see application-service.entity.ts) so
  // it matches the migration's constraint name instead of TypeORM's
  // auto-generated hash, which `migration:generate` would otherwise want to rename.
  @Index('UQ_infrastructure_operation_logs_operationId', { unique: true })
  @Column({ type: 'uuid' })
  operationId: string;

  @Column({ type: 'text', default: '' })
  content: string;

  /** Bytes already read from `sourceFile` on the node — where the next `tail` resumes. */
  @Column({ type: 'int', default: 0 })
  byteOffset: number;

  @Column({ type: 'varchar', nullable: true })
  sourceFile?: string | null;

  /** Set once `content` hits the size cap; tailing stops for this operation from then on. */
  @Column({ type: 'boolean', default: false })
  truncated: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
