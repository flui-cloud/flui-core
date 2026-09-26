import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export const DEFERRED_ACTION_KINDS = ['apply-resource-proposal'] as const;
export type DeferredActionKind = (typeof DEFERRED_ACTION_KINDS)[number];

export const DEFERRED_ACTION_STATUSES = [
  'pending',
  'applied',
  'discarded',
  'alerted',
  'failed',
  'cancelled',
] as const;
export type DeferredActionStatus = (typeof DEFERRED_ACTION_STATUSES)[number];

/** Something a person asked for that restarts work, held until the next maintenance window opens. */
@Entity('deferred_actions')
@Index('IDX_deferred_actions_due', ['status', 'runAt'])
@Index('IDX_deferred_actions_cluster', ['clusterId'])
export class DeferredActionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  kind: DeferredActionKind;

  @Column('uuid')
  clusterId: string;

  @Column({ type: 'uuid', nullable: true })
  applicationId: string | null;

  @Column({ type: 'varchar' })
  requestedBy: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  requestedAt: Date;

  /** The opening it waits for. */
  @Column({ type: 'timestamptz' })
  runAt: Date;

  @Column({ type: 'varchar', default: 'pending' })
  status: DeferredActionStatus;

  /** What became of it, in a sentence. */
  @Column({ type: 'text', nullable: true })
  outcome: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  settledAt: Date | null;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  payload: Record<string, unknown>;
}
