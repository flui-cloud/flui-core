import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/**
 * A guest who asked for a space when every slot was in use. Served in order of
 * arrival: when a slot frees, the first in line is offered it by mail and holds
 * it until `offerExpiresAt`.
 */
@Entity('sandbox_waitlist')
@Unique('UQ_sandbox_waitlist_user', ['userId'])
export class SandboxWaitlistEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  email: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  offeredAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  offerExpiresAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
