import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type AuditOutcome = 'ok' | 'refused' | 'failed';

/**
 * One thing somebody did, or tried to do, through the API.
 *
 * Every change is recorded, every refusal, and every read that reaches the data
 * of an application (a log, a console, a backup). Plain reads of the platform
 * are not: they would bury the rows a person comes here to find.
 *
 * Unlike `mcp_tool_call_logs` (what an agent did under which standing
 * permission), this answers who did what, for every principal, per request.
 */
@Entity('audit_events')
@Index('IDX_audit_events_at', ['at'])
@Index('IDX_audit_events_email_at', ['email', 'at'])
export class AuditEventEntity {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_audit_events',
  })
  id: string;

  @CreateDateColumn({ type: 'timestamptz' })
  at: Date;

  @Column({ type: 'varchar', nullable: true })
  userId: string | null;

  @Column({ type: 'varchar', nullable: true })
  email: string | null;

  /** `user`, `key` or `agent` — see `ActorKind`. */
  @Column({ type: 'varchar', nullable: true })
  actorKind: string | null;

  /** `api_keys.id` when a key made the call. No foreign key: the record outlives the key. */
  @Column({ type: 'varchar', nullable: true })
  actorKeyId: string | null;

  /** The declared route shape, `POST /iam/grants/:id`, or a named event such as `ssh certificate issued`. */
  @Column({ type: 'varchar' })
  action: string;

  /** Route parameters only, never the body: a body is where a secret would be. */
  @Column({ type: 'jsonb', nullable: true })
  target: Record<string, string> | null;

  @Column({ type: 'int', nullable: true })
  status: number | null;

  @Column({ type: 'varchar' })
  outcome: AuditOutcome;

  /** The permission the route asked for, when it asked for one. */
  @Column({ type: 'varchar', nullable: true })
  permission: string | null;

  /** True when the action reached the data of an application. */
  @Column({ type: 'boolean', default: false })
  dataAccess: boolean;
}
