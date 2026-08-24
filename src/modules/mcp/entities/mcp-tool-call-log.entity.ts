import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('mcp_tool_call_logs')
export class McpToolCallLogEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  user_id: string;

  @Column()
  tool: string;

  @Column()
  scope: string;

  @Column({ default: false })
  allowed: boolean;

  @Column({ type: 'varchar', nullable: true })
  error: string | null;

  /**
   * What the turn ended as, when "allowed and no error" is not the whole truth.
   *
   * An MRTR turn that stops to ask a person is `allowed: true, error: null` —
   * indistinguishable from a success, though nothing was done. Writing
   * 'input_required' into `error` would be a lie: it is a state, not a failure.
   * Null everywhere else on purpose: `allowed` and `error` already say refused
   * and failed, and a column that repeats them is debt.
   */
  @Column({ type: 'varchar', nullable: true })
  outcome: string | null;

  /**
   * Whether a person, a plain key or an agent made the call — see `ActorKind`.
   *
   * `user_id` alone could never answer it: a Flui key is issued *as* its
   * principal, so an agent's call and its owner's call are the same row. Null
   * on every row written before this column existed, which is not the same
   * claim as "a person did it" and must not be rendered as one.
   */
  @Column({ type: 'varchar', nullable: true })
  actor_kind: string | null;

  /**
   * `api_keys.id`, when a key authenticated the call. Deliberately not a
   * foreign key: the log outlives the credential, and a revoked-then-deleted
   * key must not be able to take the record of what it did with it.
   */
  @Column({ type: 'varchar', nullable: true })
  actor_key_id: string | null;

  /**
   * The call's arguments, redacted by `redactToolArgs` — closed-set values
   * verbatim, everything else `****`. Never the raw arguments: `catalog_install`
   * carries `userInputs`, and that is where a password would be.
   */
  @Column({ type: 'jsonb', name: 'arguments', nullable: true })
  args: Record<string, unknown> | null;

  /**
   * The async operation the call started, when it started one. It is how a
   * screen recovers *what* was acted on: the operations row carries the
   * resource, written by the server rather than supplied by a model.
   */
  @Column({ type: 'varchar', nullable: true })
  operation_id: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
