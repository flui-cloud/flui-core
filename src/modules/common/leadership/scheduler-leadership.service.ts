import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { DataSource, QueryRunner } from 'typeorm';

/** The advisory lock every copy of the API competes for: Flui's own keyspace, then "scheduler". */
const LOCK_CLASS = 0x464c5549;
const LOCK_OBJECT = 1;

const POLL_MS = Number(process.env.FLUI_LEADERSHIP_POLL_MS) || 5000;

/**
 * Prefix for a job that keeps this copy's own memory up to date rather than
 * doing shared work: it runs on every copy, leader or not.
 */
export const LOCAL_JOB = 'local:';

/**
 * Exactly one copy of the API runs the scheduled work.
 *
 * Every `@Cron` would otherwise fire on every copy at the same second: two
 * backups for one policy, two waiting-list mails, two nodes bought for one
 * shortage. The copy holding a session-level Postgres advisory lock is the
 * leader and keeps the jobs running; the others stop theirs. The lock lives
 * on a connection of its own, so it goes with the copy: when that copy stops
 * or loses the database, another one takes over within a poll.
 */
@Injectable()
export class SchedulerLeadershipService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(SchedulerLeadershipService.name);
  private runner: QueryRunner | null = null;
  private leader = false;
  private timer: NodeJS.Timeout | null = null;
  private checking = false;
  private readonly listeners = new Set<(leader: boolean) => void>();

  constructor(
    private readonly dataSource: DataSource,
    private readonly registry: SchedulerRegistry,
  ) {}

  isLeader(): boolean {
    return this.leader;
  }

  /** Called on every change, and once at once with the current state. */
  onChange(listener: (leader: boolean) => void): () => void {
    this.listeners.add(listener);
    listener(this.leader);
    return () => this.listeners.delete(listener);
  }

  async onApplicationBootstrap(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
    await this.check();
    this.timer = setInterval(() => void this.check(), POLL_MS);
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.setLeader(false);
    this.applyToJobs();
    await this.release();
  }

  /** Takes the lock if it is free, confirms it is still held, and makes the jobs agree. */
  async check(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      this.setLeader(await this.holdsLock());
    } catch (error) {
      this.logger.warn(
        `Lost the database while checking who runs the scheduled work: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.setLeader(false);
      await this.release();
    } finally {
      this.applyToJobs();
      this.checking = false;
    }
  }

  private async holdsLock(): Promise<boolean> {
    if (!this.runner || this.runner.isReleased) {
      this.runner = this.dataSource.createQueryRunner();
      await this.runner.connect();
    }
    if (this.leader) {
      const held = await this.runner.query(
        `SELECT 1 FROM pg_locks
          WHERE locktype = 'advisory' AND pid = pg_backend_pid()
            AND classid = $1 AND objid = $2 AND objsubid = 2 AND granted`,
        [LOCK_CLASS, LOCK_OBJECT],
      );
      return held.length > 0;
    }
    const [row] = await this.runner.query(
      'SELECT pg_try_advisory_lock($1, $2) AS held',
      [LOCK_CLASS, LOCK_OBJECT],
    );
    return row?.held === true;
  }

  private setLeader(leader: boolean): void {
    if (leader === this.leader) return;
    this.leader = leader;
    this.logger.log(
      leader
        ? 'This copy of the API now runs the scheduled work'
        : 'This copy of the API no longer runs the scheduled work',
    );
    for (const listener of this.listeners) listener(leader);
  }

  private applyToJobs(): void {
    for (const [name, job] of this.registry.getCronJobs()) {
      if (name.startsWith(LOCAL_JOB)) continue;
      if (this.leader && !job.isActive) job.start();
      if (!this.leader && job.isActive) job.stop();
    }
  }

  /**
   * A released connection goes back to the pool still holding a session lock,
   * which would keep every copy from leading: the lock is let go first.
   */
  private async release(): Promise<void> {
    const runner = this.runner;
    this.runner = null;
    if (!runner || runner.isReleased) return;
    await runner
      .query('SELECT pg_advisory_unlock($1, $2)', [LOCK_CLASS, LOCK_OBJECT])
      .catch(() => undefined);
    await runner.release().catch(() => undefined);
  }
}
