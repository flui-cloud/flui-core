import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
  ValueTransformer,
} from 'typeorm';
import { DemoLoopState, DemoProvisionMode } from '../enums/demo.enum';

/** Single-row table; the demo has exactly one configuration/state. */
export const DEMO_CONFIG_SINGLETON_ID = 'demo';

/** bigint columns read back as strings from pg — keep them numeric in TS. */
const bigintNumber: ValueTransformer = {
  to: (v?: number) => v,
  from: (v?: string) => (v == null ? 0 : Number(v)),
};

@Entity('demo_config')
export class DemoConfigEntity {
  @PrimaryColumn({ type: 'varchar', length: 16 })
  id: string;

  @Column({ default: false })
  enabled: boolean;

  @Column({
    type: 'enum',
    enum: DemoProvisionMode,
    default: DemoProvisionMode.FIXED_PAIR,
  })
  provisionMode: DemoProvisionMode;

  // What the loop migrates: a stateless consumer app + its managed Postgres.
  @Column({ type: 'uuid', nullable: true })
  appId?: string | null;

  @Column({ type: 'uuid', nullable: true })
  dbAppId?: string | null;

  // FIXED_PAIR: the two pre-registered workload clusters to alternate between.
  @Column({ type: 'uuid', nullable: true })
  clusterAId?: string | null;

  @Column({ type: 'uuid', nullable: true })
  clusterBId?: string | null;

  // The loop runs full-migration on behalf of this user (captured on configure).
  @Column({ type: 'varchar', length: 64, nullable: true })
  ownerUserId?: string | null;

  // Public URL the master probes to measure served / lost requests honestly.
  @Column({ type: 'varchar', length: 512, nullable: true })
  probeUrl?: string | null;

  @Column({ type: 'int', default: 2000 })
  probeIntervalMs: number;

  @Column({ type: 'int', default: 45 })
  intervalMinutes: number;

  @Column({ type: 'int', default: 10 })
  drainMinutes: number;

  // The loop always drives cutover itself (MANUAL) so it can bracket the honest
  // disruption window; only the staging mode is tunable.
  @Column({ type: 'varchar', length: 16, default: 'live-fenced' })
  stagingMode: string;

  @Column({
    type: 'enum',
    enum: DemoLoopState,
    default: DemoLoopState.IDLE,
  })
  state: DemoLoopState;

  @Column({ type: 'uuid', nullable: true })
  currentClusterId?: string | null;

  @Column({ type: 'uuid', nullable: true })
  activeFullMigrationId?: string | null;

  // Set when a cutover job has been enqueued for the active migration, so a fast
  // tick / restart does not double-enqueue while status still reads READY.
  @Column({ type: 'timestamptz', nullable: true })
  cutoverRequestedAt?: Date | null;

  // A drained source workload we still owe a teardown; blocks the next cycle
  // toward that cluster until cleared.
  @Column({ type: 'uuid', nullable: true })
  pendingCleanupMigrationId?: string | null;

  // Consecutive retryable failures on the current step; a hard stop bound.
  @Column({ type: 'int', default: 0 })
  strikes: number;

  // Open across the cutover+drain window; failed probes here are lost-to-migration.
  @Column({ default: false })
  windowOpen: boolean;

  @Column({ type: 'int', default: 0 })
  cycleCount: number;

  @Column({ type: 'timestamptz', nullable: true })
  cycleStartedAt?: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  drainStartedAt?: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastCycleAt?: Date | null;

  @Column({ type: 'int', nullable: true })
  lastCycleDurationMs?: number | null;

  @Column({ type: 'text', nullable: true })
  lastError?: string | null;

  @Column({ type: 'bigint', default: 0, transformer: bigintNumber })
  probesTotal: number;

  @Column({ type: 'bigint', default: 0, transformer: bigintNumber })
  probesOk: number;

  @Column({ type: 'bigint', default: 0, transformer: bigintNumber })
  probesFailed: number;

  @Column({ type: 'bigint', default: 0, transformer: bigintNumber })
  failedDuringMigration: number;

  @Column({ type: 'timestamptz', nullable: true })
  lastProbeAt?: Date | null;

  @Column({ type: 'boolean', nullable: true })
  lastProbeOk?: boolean | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
