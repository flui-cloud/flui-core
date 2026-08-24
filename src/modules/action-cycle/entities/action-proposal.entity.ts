import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ActionBinding, ProposalStatus } from '../action-cycle.core';

/**
 * One thing an agent tried to do and was told to ask about first.
 *
 * **The wait is a row, never a held request.** No socket stays open while a
 * person makes up their mind: the call is refused with this row's id, the agent
 * carries on with everything that does not depend on it, and the *retry* — not
 * the person's click — is what executes once the answer exists. That is the
 * shape the MCP specification prescribes for a multi-round-trip call, and it is
 * also the only shape that survives `curl`: the same agent key on the command
 * line meets the same guard and gets the same id back, with no client
 * cooperation required at all.
 *
 * What is deliberately absent is the request body. Only its digest is kept, so
 * two identical attempts collapse onto one question, while a catalog install's
 * `userInputs` — where an administrator password lands — never reaches a table
 * that exists to be read by a person.
 */
@Entity('action_proposals')
@Index(['ownerUserId', 'status'])
export class ActionProposalEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * The person the agent acts for, and the only one who may answer.
   *
   * Ownership rather than a permission: a proposal is a question addressed to
   * somebody, and an operator holding the whole instance still has no standing
   * to answer a question that was not asked of them.
   */
  @Column({ type: 'varchar' })
  ownerUserId: string;

  /** `api_keys.id` of the agent credential that asked. No foreign key: the question outlives the key. */
  @Column({ type: 'varchar', nullable: true })
  keyId?: string | null;

  /** Verb + route pattern, e.g. `POST /infrastructure/clusters/:id/workers`. */
  @Column({ type: 'varchar' })
  action: string;

  /** The concrete path, kept for display only — matching is done on the pattern. */
  @Column({ type: 'varchar', nullable: true })
  routePath?: string | null;

  /** The route parameters that pin the resource, when the request could state its edge. */
  @Column({ type: 'jsonb', nullable: true })
  binding?: ActionBinding | null;

  /** sha256 of shape + binding + body. The upsert key, so a retrying agent asks once. */
  @Column({ type: 'varchar' })
  argsDigest: string;

  /** What "always" would concede, in the words shown before the answer. */
  @Column({ type: 'text' })
  sentence: string;

  /**
   * False when the request could not state its own edge — then only "once" is
   * on offer. Stored rather than recomputed so the register can show what was
   * actually offered at the time, not what the code would offer today.
   */
  @Column({ type: 'boolean', default: false })
  offersAlways: boolean;

  /** The GET route that prices this action, already filled in. Never called from the guard. */
  @Column({ type: 'varchar', nullable: true })
  estimateRef?: string | null;

  /** The price, once somebody with a credential has fetched it. */
  @Column({ type: 'jsonb', nullable: true })
  estimate?: Record<string, unknown> | null;

  @Column({ type: 'varchar', default: 'PENDING' })
  status: ProposalStatus;

  /** After this, the question — and the price on it — is stale and regenerates. */
  @Column({ type: 'timestamptz', nullable: true })
  expiresAt?: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  decidedAt?: Date | null;

  @Column({ type: 'varchar', nullable: true })
  decidedByUserId?: string | null;

  /** The concession written when the answer was "always". */
  @Column({ type: 'varchar', nullable: true })
  concessionId?: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
