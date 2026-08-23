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

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
