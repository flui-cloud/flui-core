import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import {
  ConsideredCandidate,
  DecisionOutcome,
  ScalingForce,
} from '../scaling.core';
import { DrainCheck } from '../engine/drain.core';
import { eurAmount } from './scaling-group.entity';

/**
 * What was decided, or declined — a resource somebody reads, not log lines.
 *
 * The declines are the half everybody forgets, and they answer the only
 * question a person ever asks an autoscaler: *why did you not scale?* Which is
 * why `why` is a column of its own and `considered` keeps the rungs that were
 * walked past, each with the reason it lost.
 */
@Entity('infrastructure_scaling_decisions')
@Index('IDX_scaling_decisions_group_at', ['groupId', 'at'])
@Index('IDX_scaling_decisions_cluster_at', ['clusterId', 'at'])
export class ScalingDecisionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  groupId: string;

  /**
   * Carried beside the group so the overview can ask for a cluster's last
   * decision without walking its groups first.
   */
  @Column('uuid')
  clusterId: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  at: Date;

  @Column({ type: 'varchar' })
  force: ScalingForce;

  @Column({ type: 'varchar' })
  outcome: DecisionOutcome;

  /** What it saw. */
  @Column({ type: 'text' })
  saw: string;

  /** What it did, or would have done. */
  @Column({ type: 'text' })
  did: string;

  /** Why — and on a decline this is the whole content. */
  @Column({ type: 'text' })
  why: string;

  /**
   * The sentence addressed to a person, on an alarm.
   *
   * Where nothing can be bought the last rung is a request rather than a
   * purchase, and it has to survive as its own text: `did` describes the
   * decision, this is what somebody has to go and do.
   */
  @Column({ type: 'text', nullable: true })
  asks: string | null;

  @Column({ type: 'varchar', nullable: true })
  shape: string | null;

  @Column({ type: 'varchar', nullable: true })
  region: string | null;

  /** Null is not zero: the operator's own machines carry no price Flui sees. */
  @Column({
    type: 'numeric',
    precision: 12,
    scale: 6,
    nullable: true,
    transformer: eurAmount,
  })
  hourlyPriceEur: number | null;

  /** What it did not choose, and why each one lost. */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  considered: ConsideredCandidate[];

  /**
   * How many pods the scheduler could not place when this was decided.
   *
   * Null is *"the cluster could not be asked"*, which is the reading that must
   * never arrive as 0: a list of clusters showing zero waiting everywhere would
   * report calm during an outage.
   */
  @Column({ type: 'int', nullable: true })
  pendingPods: number | null;

  /**
   * Whether the node this decision would have emptied can be emptied.
   *
   * Kept on the decision because it is what the pass saw, and because the
   * alternative is a list of clusters asking every node of every fleet the same
   * question again, over the network, once per row.
   */
  @Column({ type: 'jsonb', nullable: true })
  drain: DrainCheck | null;
}
