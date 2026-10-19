import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AlertEventsService } from '../../observability/services/alert-events.service';
import { AlertMailService } from '../../observability/services/alert-mail.service';
import { InferenceUsageService } from './inference-usage.service';

export const DEFAULT_SPEND_THRESHOLDS = [5_000_000, 20_000_000, 50_000_000];

/**
 * Daily token totals that tell the operator how much inference the instance is
 * spending, from `INFERENCE_SPEND_ALERT_DAILY_TOKENS` (comma separated). Empty
 * or `off` sends nothing.
 */
export function spendThresholds(
  raw: string | undefined = process.env.INFERENCE_SPEND_ALERT_DAILY_TOKENS,
): number[] {
  if (raw === undefined || raw.trim() === '') return DEFAULT_SPEND_THRESHOLDS;
  if (raw.trim().toLowerCase() === 'off') return [];
  const values = raw
    .split(',')
    .map((v) => Number(v.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return [...new Set(values)].sort((a, b) => a - b);
}

/** Daily totals of guest inference alone, from `SANDBOX_INFERENCE_ALERT_DAILY_TOKENS`. Unset sends nothing. */
export function guestSpendThresholds(
  raw: string | undefined = process.env.SANDBOX_INFERENCE_ALERT_DAILY_TOKENS,
): number[] {
  return raw?.trim() ? spendThresholds(raw) : [];
}

interface SpendMeasure {
  alertname: string;
  fingerprint: string;
  thresholds: number[];
  spent: (since: Date) => Promise<number>;
  summary: (spent: string, threshold: string) => string;
  description: string;
}

function startOfUtcDay(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

/**
 * Tells the operator when the instance's inference spend for the day crosses a
 * threshold. A notice, not a ceiling: nobody is refused. One mail per threshold
 * per day, kept across restarts by the alert's fingerprint.
 */
@Injectable()
export class InferenceSpendAlertService {
  static readonly ALERTNAME = 'FluiInferenceDailySpend';
  static readonly GUEST_ALERTNAME = 'FluiGuestInferenceDailySpend';
  private readonly logger = new Logger(InferenceSpendAlertService.name);

  constructor(
    private readonly usage: InferenceUsageService,
    private readonly alerts: AlertEventsService,
    private readonly mail: AlertMailService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async tick(): Promise<void> {
    try {
      await this.check(new Date());
    } catch (error) {
      this.logger.warn(
        `Could not read today's inference spend: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Returns how many mails went out. */
  async check(now: Date): Promise<number> {
    let sent = 0;
    for (const measure of this.measures()) {
      if (measure.thresholds.length === 0) continue;
      sent += await this.checkMeasure(measure, now);
    }
    return sent;
  }

  private measures(): SpendMeasure[] {
    return [
      {
        alertname: InferenceSpendAlertService.ALERTNAME,
        fingerprint: 'inference-spend',
        thresholds: spendThresholds(),
        spent: (since) => this.usage.totalSince(since),
        summary: (spent, threshold) =>
          `Inference spent ${spent} tokens today, past ${threshold}`,
        description:
          'Nobody is refused: each person keeps their own budget. See who is spending with `flui inference usage`.',
      },
      {
        alertname: InferenceSpendAlertService.GUEST_ALERTNAME,
        fingerprint: 'inference-guest-spend',
        thresholds: guestSpendThresholds(),
        spent: (since) => this.usage.guestTotalSince(since),
        summary: (spent, threshold) =>
          `Demo guests spent ${spent} tokens of the instance's inference today, past ${threshold}`,
        description:
          'The instance pays for guest inference. SANDBOX_INFERENCE_DAILY_TOKENS stops it for the day; SANDBOX_INFERENCE_ENABLED=false pauses it. See who is spending with `flui inference usage`.',
      },
    ];
  }

  private async checkMeasure(
    measure: SpendMeasure,
    now: Date,
  ): Promise<number> {
    const dayStart = startOfUtcDay(now);
    const spent = await measure.spent(dayStart);
    const day = dayStart.toISOString().slice(0, 10);
    let sent = 0;

    for (const threshold of measure.thresholds.filter((t) => spent >= t)) {
      const transitions = await this.alerts.record([
        {
          fingerprint: `${measure.fingerprint}-${day}-${threshold}`,
          status: 'firing',
          startsAt: dayStart,
          endsAt: null,
          alertname: measure.alertname,
          severity: 'warning',
          fluiKind: 'inference',
          labels: { threshold: String(threshold) },
          annotations: {
            summary: measure.summary(
              spent.toLocaleString('en-US'),
              threshold.toLocaleString('en-US'),
            ),
            description: measure.description,
          },
        },
      ]);
      for (const { kind, event } of transitions) {
        if (kind !== 'fired') continue;
        if (await this.mail.deliver(kind, event, { adminWarnings: true })) {
          sent += 1;
        }
      }
    }
    return sent;
  }
}
