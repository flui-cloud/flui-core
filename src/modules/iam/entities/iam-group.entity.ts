import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Flui-local group: membership lives here (not in the IdP), so it works under
 * BYOIdP and group CRUD is pure Flui. Members are referenced symbolically by email.
 */
@Entity('iam_groups')
export class IamGroupEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', unique: true })
  name: string;

  @Column({ type: 'varchar', nullable: true })
  description: string | null;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  members: string[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
