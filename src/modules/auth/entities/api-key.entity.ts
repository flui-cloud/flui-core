import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('api_keys')
export class ApiKeyEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  key: string;

  @Column()
  name: string;

  @Column({ default: false })
  revoked: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ nullable: true, type: 'timestamptz' })
  expiresAt: Date;

  @Column({ nullable: true, type: 'varchar' })
  userId: string | null;

  /** Granted scopes for non-interactive agent tokens (e.g. MCP). Null = no scoped grant. */
  @Column({ type: 'simple-array', nullable: true })
  scopes: string[] | null;
}
