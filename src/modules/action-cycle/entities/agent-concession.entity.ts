import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ActionBinding } from '../action-cycle.core';

/**
 * "Allow always", made a row that can be found and taken back.
 *
 * It is a new entity rather than an IAM binding, and that is the load-bearing
 * decision of the whole step: `iam_role_bindings` is the *ceiling* of the
 * person, and a panel that wrote a consent there would let the gesture "allow
 * this agent to add nodes" quietly raise the ceiling it hangs from. A
 * concession can only ever remove a *pause* on a route the guards already let
 * through — it grants nothing, so it cannot grant too much.
 *
 * For the same reason it names no permission. It names a route shape, a
 * resource, and the sentence the person actually read:
 *
 *   action   POST /infrastructure/clusters/:id/workers
 *   binding  { id: '<uuid of control-cluster>' }
 *   sentence "add nodes to cluster <uuid>"
 *
 * Machine-checkable through `routeMatches` plus equality of the bound
 * parameters; human-readable through a sentence that is stored verbatim rather
 * than rebuilt, so the register shows what was agreed to and not a
 * reconstruction of it.
 */
@Entity('agent_concessions')
@Index(['ownerUserId', 'revokedAt'])
export class AgentConcessionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * The agent credential this was given to — `api_keys.id`.
   *
   * Required in practice even though the column is nullable: a credential whose
   * `mcp:*` ceiling arrives through the identity provider's project roles has
   * no key row at all, and there is nothing to bind a standing permission to.
   * Such a caller is offered "once" and never "always" — fail-closed, and the
   * absence is the reason rather than an oversight.
   */
  @Column({ type: 'varchar', nullable: true })
  keyId?: string | null;

  /** Who granted it, and the only one who can take it back. */
  @Column({ type: 'varchar' })
  ownerUserId: string;

  /** Verb + route pattern. Only ever written from a decorated route. */
  @Column({ type: 'varchar' })
  action: string;

  /** The parameters nailed down. Empty means the shape alone, which is only reachable when a route declares no edge — and such a route never offers "always". */
  @Column({ type: 'jsonb', nullable: true })
  binding?: ActionBinding | null;

  /** The sentence read at the moment of the yes, stored as it was read. */
  @Column({ type: 'text' })
  sentence: string;

  /** The proposal this came out of, so the register can show what asked for it. */
  @Column({ type: 'varchar', nullable: true })
  fromProposalId?: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  /** Touched every time the concession lets a call through. */
  @Column({ type: 'timestamptz', nullable: true })
  lastUsedAt?: Date | null;

  /**
   * Set once, and never unset.
   *
   * Revoking stops future departures immediately and for nothing — the guard
   * reads this table on every request, so there is no cache to invalidate and
   * no window to close. It deliberately does **not** abort what is already
   * running: a ten-step provisioning cut in half leaves paid-for debris behind
   * (`env orphan-volumes` exists *because* that failure mode exists). Stopping
   * what has already left is a separate, cooperative gesture at a step
   * boundary — see the cancellation request on the operation.
   */
  @Column({ type: 'timestamptz', nullable: true })
  revokedAt?: Date | null;

  @Column({ type: 'varchar', nullable: true })
  revokedByUserId?: string | null;
}
