import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * A visitor made ahead of time: the identity-provider account and a signed-in
 * session, so the entrance only has to hand the session over.
 */
@Entity('sandbox_visitor_pool')
@Index('IDX_sandbox_visitor_pool_taken_created', ['takenAt', 'createdAt'])
export class SandboxVisitorPoolEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 64 })
  idpUserId: string;

  @Column({ type: 'varchar', length: 128 })
  sessionId: string;

  /** Emptied once taken: a used session is never kept. */
  @Column({ type: 'text' })
  sessionTokenEncrypted: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  takenAt: Date | null;
}
