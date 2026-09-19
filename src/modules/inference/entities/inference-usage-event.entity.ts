import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * One inference call, and what it cost in tokens.
 *
 * A ledger rather than a counter on the person's row, because the question an
 * operator asks is not only "how much" but "on which model" — and a running
 * total cannot be taken apart afterwards. The budget a guest spends against is
 * a `SUM` over this table, so there is one number and nothing to drift.
 *
 * Every surface that spends writes here: the assistant and the six console
 * copilots all reach the provider through one call point, which is the only
 * reason a single table can honestly claim to be the whole bill.
 */
@Entity('inference_usage_events')
@Index('idx_inference_usage_user_created', ['userId', 'createdAt'])
@Index('idx_inference_usage_created', ['createdAt'])
export class InferenceUsageEventEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Who spent it. Null for a call made by the platform itself. */
  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  /** True when that person was a sandbox guest, so the instance paid. */
  @Column({ type: 'boolean', default: false })
  guest: boolean;

  @Column({ length: 128 })
  model: string;

  /** Where the call went, without the path — enough to tell providers apart. */
  @Column({ length: 255 })
  endpoint: string;

  /** Which part of the product spent it: `assistant`, `console:db`, and so on. */
  @Column({ length: 64 })
  surface: string;

  @Column({ type: 'integer', default: 0 })
  promptTokens: number;

  @Column({ type: 'integer', default: 0 })
  completionTokens: number;

  /**
   * True when the provider did not report a count and this was worked out from
   * the text. Kept rather than hidden: a budget built on guesses should be able
   * to say how much of it is guessed.
   */
  @Column({ type: 'boolean', default: false })
  estimated: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
