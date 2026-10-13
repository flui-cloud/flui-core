import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { UserEntity } from '../../auth/entities/user.entity';

/**
 * What only a visitor of the demo has, beside its `users` row of kind
 * `visitor`. Kept after a visitor is merged into an existing account, as the
 * record of where it went, and after a visitor who left is removed, as the
 * record that its identity is gone: the person row is gone then, so `userId`
 * carries no foreign key.
 */
@Entity('sandbox_visitors')
export class SandboxVisitorEntity {
  @PrimaryColumn('uuid')
  userId: string;

  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'userId' })
  user?: UserEntity;

  @Index('IDX_sandbox_visitors_idp_user')
  @Column({ type: 'varchar', length: 64 })
  idpUserId: string;

  @Column({ type: 'varchar', length: 128, nullable: true })
  ipHash: string | null;

  @Index('IDX_sandbox_visitors_created')
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  upgradedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  removedAt: Date | null;

  @Index('IDX_sandbox_visitors_linked_user')
  @Column({ type: 'uuid', nullable: true })
  linkedUserId: string | null;

  @ManyToOne(() => UserEntity, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'linkedUserId' })
  linkedUser?: UserEntity;
}
