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
    const thresholds = spendThresholds();
    if (thresholds.length === 0) return 0;

    const dayStart = startOfUtcDay(now);
    const spent = await this.usage.totalSince(dayStart);
    const day = dayStart.toISOString().slice(0, 10);
    let sent = 0;

    for (const threshold of thresholds.filter((t) => spent >= t)) {
      const transitions = await this.alerts.record([
        {
          fingerprint: `inference-spend-${day}-${threshold}`,
          status: 'firing',
          startsAt: dayStart,
          endsAt: null,
          alertname: InferenceSpendAlertService.ALERTNAME,
          severity: 'warning',
          fluiKind: 'inference',
          labels: { threshold: String(threshold) },
          annotations: {
            summary: `Inference spent ${spent.toLocaleString('en-US')} tokens today, past ${threshold.toLocaleString('en-US')}`,
            description:
              'Nobody is refused: each person keeps their own budget. See who is spending with `flui inference usage`.',
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
