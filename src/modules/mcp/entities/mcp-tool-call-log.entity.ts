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

  /**
   * The request this call is *about*: the one it raised by stopping to ask, or
   * the one already standing over it when the answer was "no" and the same call
   * came round again.
   *
   * The mirror of `operation_id`: that one says what a call *started*, this one
   * says what it *asked for*. Only the second needed a column — a call that
   * departed under an answer already names its request through the operation's
   * grant, while the turn that raised the question shares no key with
   * `action_proposals` at all, and correlating the two on user, credential and
   * instant would be a guess.
   *
   * Deliberately not a foreign key, for the reason `actor_key_id` is not one:
   * the register outlives what it names. A cleaned-up request, or a permission
   * taken back, must not take the record of what was asked with it.
   */
  @Column({ type: 'varchar', nullable: true })
  proposal_id: string | null;

  /**
   * Which door the call came through — `mcp`, `assistant` or `api`; see
   * `RegisterSurface`.
   *
   * The table is called `mcp_tool_call_logs` and is no longer only MCP's. It is
   * not renamed: renaming under `synchronize: true` drops the old table with its
   * rows in it, and a register that loses its history to a rename is worse than
   * a register with a dated name. The name stays; this column tells the truth.
   *
   * Null on every row written before it existed, which is not the same claim as
   * `api` and must not be rendered as one.
   */
  @Column({ type: 'varchar', nullable: true })
  surface: string | null;

  /**
   * The answer that removed the pause, when the writer of this row knew it
   * first-hand: a concession id, or the proposal id of a spent "allow once".
   *
   * The two agentic surfaces reach this fact through the operation the call
   * started, which is where the guard stamps its verdict — and that works
   * because a tool result carries an operation id back. A call written by the
   * door itself has no result to read: a guard runs before the handler, so it
   * knows the verdict and never learns what the handler went on to create. The
   * fact is therefore recorded where it is known rather than derived where it
   * is not.
   *
   * Not a foreign key, for the reason `actor_key_id` is not one: a permission
   * taken back must not take the record of what departed under it.
   */
  @Column({ type: 'varchar', nullable: true })
  grant_id: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
