import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum IdentityRole {
  ADMIN = 'admin',
  USER = 'user',
  READONLY = 'readonly',
}

@Entity('users')
export class UserEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  email: string;

  @Column({ nullable: true })
  passwordHash: string | null;

  @Column({ nullable: true })
  name: string;

  @Column({ default: false })
  isAdmin: boolean;

  @Column({
    type: 'enum',
    enum: IdentityRole,
    default: IdentityRole.USER,
  })
  role: IdentityRole;

  @Index({ unique: true, where: '"oidcSub" IS NOT NULL' })
  @Column({ type: 'varchar', nullable: true })
  oidcSub: string | null;

  @Column({ type: 'varchar', nullable: true })
  firstName: string | null;

  @Column({ type: 'varchar', nullable: true })
  lastName: string | null;

  @Column({ type: 'varchar', nullable: true })
  displayName: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  profileSyncedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastSeenAt: Date | null;

  /** Set by an administrator: every request of this person is refused. */
  @Column({ type: 'timestamptz', nullable: true })
  blockedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  blockedReason: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
