import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import {
  NodeRequirement,
  PlacementStrategy,
  ProvisionMode,
  StandingOrderConfig,
} from '../scaling.core';

/**
 * A cap stored as `numeric` comes back a string; `null` and `0` are different
 * answers here and must not collapse into one on the way through.
 */
export const eurAmount = {
  to: (value?: number | null): number | null => value ?? null,
  from: (value: string | null): number | null =>
    value === null ? null : Number(value),
};

/**
 * What a cluster may buy for itself, and where it may stop.
 *
 * A resource rather than a block of columns on the cluster, because a cluster
 * commonly wants more than one — one group for the general work, one for the
 * heavy jobs — and the two differ in every field below.
 */
@Entity('infrastructure_scaling_groups')
// Named, and named the same as the migration that creates them. Left unnamed,
// TypeORM expects a hash of its own and a schema built by the migration never
// matches the one the entities describe — every boot with synchronize on then
// drops these and rebuilds them under another name.
@Index('IDX_scaling_groups_cluster_name', ['clusterId', 'name'], {
  unique: true,
})
export class ScalingGroupEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_scaling_groups_cluster')
  @Column('uuid')
  clusterId: string;

  @Column({ type: 'varchar' })
  name: string;

  /** The floor. Held now, always. Below it the installation is broken. */
  @Column({ type: 'int', default: 1 })
  minNodes: number;

  /**
   * The target, and deliberately not the desired capacity of an AWS group:
   * being below it buys nothing now. It is where the fleet would like to sit,
   * reached when the market allows, and the resting point a scale-down returns
   * to.
   */
  @Column({ type: 'int', default: 1 })
  desiredNodes: number;

  /** The ceiling urgency may reach *right now*, with whatever it finds. */
  @Column({ type: 'int', default: 1 })
  maxNodes: number;

  /** Where it may buy. Plural: this is what opens "cheapest, anywhere". */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  regions: string[];

  /** What it may buy, in order of preference. The order is the preference. */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  shapes: string[];

  @Column({ type: 'varchar', default: 'uniform' })
  strategy: PlacementStrategy;

  /**
   * How long a pod must have been stuck before this buys anything.
   *
   * Not patience: it never waits for a cheaper shape. It waits to be sure the
   * pod is genuinely stuck rather than caught mid-schedule — another pod
   * terminating, a drain finishing, the scheduler halfway round. It belongs to
   * the urgent path alone; the opportunistic side has no use for it.
   */
  @Column({ type: 'int', default: 30 })
  settleSeconds: number;

  /** Refuse shapes billed monthly-only: they make autoscale cost-neutral at best. */
  @Column({ type: 'boolean', default: false })
  hourlyBillingOnly: boolean;

  /** In currency, not in node count — the number of nodes is not the bill. */
  @Column({
    type: 'numeric',
    precision: 12,
    scale: 2,
    nullable: true,
    transformer: eurAmount,
  })
  maxMonthlyCost: number | null;

  @Column({ type: 'varchar', default: 'manual' })
  provision: ProvisionMode;

  /**
   * The opportunistic side: what the group would rather be running.
   *
   * A list, because a group commonly wants two things at once — grow toward the
   * target with the shape it prefers, *and* give back a stand-in urgency bought
   * in a hurry. Modelling one killed the commoner of the two.
   */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  standingOrders: StandingOrderConfig[];

  /**
   * What a machine has to hold, where no catalogue exists to name a shape from.
   *
   * Null wherever there is one: there the preferred shapes carry the same
   * information with a price attached.
   */
  @Column({ type: 'jsonb', nullable: true })
  requirement: NodeRequirement | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
