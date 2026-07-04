import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { DemoStateService } from './demo-state.service';
import { DemoEventsService, DemoEventType } from './demo-events.service';
import { DemoLoopState } from '../enums/demo.enum';

export interface DemoCounters {
  probesTotal: number;
  probesOk: number;
  probesFailed: number;
  failedDuringMigration: number;
  lastProbeAt: string | null;
  lastProbeOk: boolean | null;
}

const IDLE_TICK_MS = 5_000;
const FLUSH_EVERY_MS = 15_000;
const PROBE_TIMEOUT_CAP_MS = 4_000;

/**
 * The master is the fixed narrator: it probes the migrating app's public URL on
 * a steady cadence and counts 2xx as served, everything else as failed. Failures
 * that land inside a migration's cutover+drain window are attributed as
 * lost-to-migration — the honest "requests lost during migration" number (§9).
 */
@Injectable()
export class DemoProberService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DemoProberService.name);

  private counters: DemoCounters = {
    probesTotal: 0,
    probesOk: 0,
    probesFailed: 0,
    failedDuringMigration: 0,
    lastProbeAt: null,
    lastProbeOk: null,
  };
  private dirty = false;
  private lastFlushAt = 0;
  private stopped = false;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly state: DemoStateService,
    private readonly events: DemoEventsService,
  ) {}

  async onModuleInit(): Promise<void> {
    const cfg = await this.state.get();
    this.counters = {
      probesTotal: cfg.probesTotal ?? 0,
      probesOk: cfg.probesOk ?? 0,
      probesFailed: cfg.probesFailed ?? 0,
      failedDuringMigration: cfg.failedDuringMigration ?? 0,
      lastProbeAt: cfg.lastProbeAt ? cfg.lastProbeAt.toISOString() : null,
      lastProbeOk: cfg.lastProbeOk ?? null,
    };
    this.scheduleNext(IDLE_TICK_MS);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.dirty) await this.flush(false); // don't lose counters on graceful restart
  }

  snapshot(): DemoCounters {
    return { ...this.counters };
  }

  async resetCounters(): Promise<void> {
    this.counters = {
      probesTotal: 0,
      probesOk: 0,
      probesFailed: 0,
      failedDuringMigration: 0,
      lastProbeAt: null,
      lastProbeOk: null,
    };
    await this.flush(true);
  }

  private scheduleNext(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.tick().catch((err) =>
        this.logger.error(`[demo-prober] tick failed: ${err?.message ?? err}`),
      );
    }, ms);
  }

  private async tick(): Promise<void> {
    let nextMs = IDLE_TICK_MS;
    try {
      const cfg = await this.state.get();
      // Keep narrating while a cycle is still in flight even if just disabled.
      const active =
        cfg.enabled || cfg.state !== DemoLoopState.IDLE || cfg.windowOpen;
      if (!active || !cfg.probeUrl) {
        await this.maybeFlush();
        return;
      }
      nextMs = cfg.probeIntervalMs;
      const timeout = Math.min(cfg.probeIntervalMs, PROBE_TIMEOUT_CAP_MS);
      const windowAtStart = cfg.windowOpen;
      const ok = await this.probe(cfg.probeUrl, timeout);

      this.counters.probesTotal += 1;
      this.counters.lastProbeAt = new Date().toISOString();
      this.counters.lastProbeOk = ok;
      if (ok) {
        this.counters.probesOk += 1;
      } else {
        this.counters.probesFailed += 1;
        // Attribute to migration if the window was open at either edge of the
        // probe (the cutover can flip the window mid-flight).
        const windowNow = windowAtStart || (await this.windowOpenNow());
        if (windowNow) this.counters.failedDuringMigration += 1;
      }
      this.dirty = true;
      await this.maybeFlush();
    } finally {
      this.scheduleNext(nextMs);
    }
  }

  private async probe(url: string, timeoutMs: number): Promise<boolean> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // Follow redirects (http→https at the edge) but only a final 2xx from the
      // app itself counts as served — a 3xx to an error page is not "served".
      const res = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        redirect: 'follow',
      });
      return res.status >= 200 && res.status < 300;
    } catch {
      return false;
    } finally {
      clearTimeout(t);
    }
  }

  private async windowOpenNow(): Promise<boolean> {
    try {
      return (await this.state.get()).windowOpen;
    } catch {
      return false;
    }
  }

  private async maybeFlush(): Promise<void> {
    const now = Date.now();
    if (!this.dirty) return;
    if (now - this.lastFlushAt < FLUSH_EVERY_MS) return;
    await this.flush(false);
  }

  private async flush(emit: boolean): Promise<void> {
    this.lastFlushAt = Date.now();
    this.dirty = false;
    await this.state.patch({
      probesTotal: this.counters.probesTotal,
      probesOk: this.counters.probesOk,
      probesFailed: this.counters.probesFailed,
      failedDuringMigration: this.counters.failedDuringMigration,
      lastProbeAt: this.counters.lastProbeAt
        ? new Date(this.counters.lastProbeAt)
        : null,
      lastProbeOk: this.counters.lastProbeOk,
    });
    if (emit) this.events.emit(DemoEventType.COUNTERS, this.snapshot());
  }
}
