import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerStorage } from '@nestjs/throttler';
import { InferenceUsageService } from '../../inference/services/inference-usage.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { countOrRefuse } from '../../../common/throttling/per-key-limit';
import { currentClientIp } from '../../auth/utils/actor-context';
import { hashIp } from '../../sandbox/visitors/visitor-ip';
import { GuestInferenceLimits } from './guest-inference-limits';
import { GuestInferenceSettingsService } from './guest-inference-settings.service';

export const GUEST_INFERENCE_THROTTLER = 'GUEST_INFERENCE_THROTTLER';
const THROTTLER_NAME = 'guest-inference';
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const GUEST_INFERENCE_CODE = {
  OFF: 'SANDBOX_INFERENCE_OFF',
  VISITORS_CLOSED: 'SANDBOX_INFERENCE_VISITORS_CLOSED',
  RATE_LIMIT: 'SANDBOX_INFERENCE_RATE_LIMIT',
  OFFTOPIC_COOLDOWN: 'SANDBOX_INFERENCE_OFFTOPIC_COOLDOWN',
  DAILY_CAP: 'SANDBOX_INFERENCE_DAILY_CAP',
  ADDRESS_CAP: 'SANDBOX_INFERENCE_ADDRESS_CAP',
} as const;

/** A visitor has no account for a coding agent to act on, so MCP is offered only to a signed-in guest. */
export function stillWorks(visitor: boolean): string {
  return visitor
    ? 'Everything else in the demo keeps working.'
    : 'Everything else in the demo keeps working, and your own coding agent can carry on over MCP.';
}

export interface GuestThrottler extends ThrottlerStorage {
  blockedSeconds(key: string, throttlerName: string): Promise<number>;
}

export interface GuestAdmission {
  budget: number;
  ipHash: string | null;
}

/**
 * The instance-wide limits on what guests may spend, checked at the inference
 * chokepoint before every guest call, whichever surface asks.
 */
@Injectable()
export class GuestInferenceGuardService {
  private ipKey: Buffer | string | null = null;

  constructor(
    private readonly settings: GuestInferenceSettingsService,
    private readonly usage: InferenceUsageService,
    @Inject(GUEST_INFERENCE_THROTTLER)
    private readonly throttler: GuestThrottler,
    private readonly encryption: EncryptionService,
    private readonly config: ConfigService,
  ) {}

  async budgetFor(visitor: boolean): Promise<number> {
    return this.budgetOf(await this.settings.limits(), visitor);
  }

  async turnAllowance(): Promise<number> {
    return (await this.settings.limits()).turnAllowance;
  }

  async admit(
    userId: string,
    visitor: boolean,
    now = new Date(),
  ): Promise<GuestAdmission> {
    const limits = await this.settings.limits(now.getTime());
    if (!limits.enabled) {
      throw new ServiceUnavailableException({
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        code: GUEST_INFERENCE_CODE.OFF,
        message: `The assistant is paused on this demo right now. ${stillWorks(visitor)}`,
      });
    }
    if (visitor && limits.visitorBudget === 0) {
      throw new ForbiddenException({
        statusCode: HttpStatus.FORBIDDEN,
        code: GUEST_INFERENCE_CODE.VISITORS_CLOSED,
        message: `The assistant opens once you sign in. ${stillWorks(true)}`,
      });
    }
    const ip = currentClientIp();
    const ipHash = ip ? this.hashAddress(ip) : null;
    await this.assertNotCoolingDown(userId, limits);
    await this.countRequest(userId, ipHash, limits);
    await this.assertInstanceDailyCap(limits, now, visitor);
    await this.assertAddressCap(ipHash, limits, now, visitor);
    return {
      budget: this.budgetOf(limits, visitor),
      ipHash: limits.ipDailyTokens ? ipHash : null,
    };
  }

  async noteOffTopic(userId: string): Promise<void> {
    const limits = await this.settings.limits();
    if (!limits.offTopicPerHour) return;
    await this.throttler.increment(
      `offtopic:${userId}`,
      HOUR_MS,
      limits.offTopicPerHour,
      limits.offTopicCooldownMs,
      THROTTLER_NAME,
    );
  }

  private budgetOf(limits: GuestInferenceLimits, visitor: boolean): number {
    return visitor && limits.visitorBudget !== null
      ? limits.visitorBudget
      : limits.areaBudget;
  }

  private hashAddress(ip: string): string {
    this.ipKey ??=
      this.config.get<string>('SANDBOX_IP_HASH_KEY')?.trim() ||
      this.encryption.deriveSubkey('sandbox.visitor.ip-hash');
    return hashIp(ip, this.ipKey);
  }

  private async countRequest(
    userId: string,
    ipHash: string | null,
    limits: GuestInferenceLimits,
  ): Promise<void> {
    const rules: Array<[string, number | null, number]> = [
      [`account:${userId}:minute`, limits.perMinute, MINUTE_MS],
      [`account:${userId}:hour`, limits.perHour, HOUR_MS],
    ];
    if (ipHash) {
      rules.push(
        [`ip:${ipHash}:minute`, limits.perIpMinute, MINUTE_MS],
        [`ip:${ipHash}:hour`, limits.perIpHour, HOUR_MS],
      );
    }
    for (const [key, limit, ttlMs] of rules) {
      if (!limit) continue;
      await countOrRefuse(this.throttler, key, {
        name: THROTTLER_NAME,
        ttlMs,
        limit,
        code: GUEST_INFERENCE_CODE.RATE_LIMIT,
        message:
          'You are asking the assistant faster than this demo allows. Wait a little and try again.',
      });
    }
  }

  private async assertNotCoolingDown(
    userId: string,
    limits: GuestInferenceLimits,
  ): Promise<void> {
    if (!limits.offTopicPerHour) return;
    const seconds = await this.throttler.blockedSeconds(
      `offtopic:${userId}`,
      THROTTLER_NAME,
    );
    if (seconds <= 0) return;
    throw tooMany(
      GUEST_INFERENCE_CODE.OFFTOPIC_COOLDOWN,
      `The assistant here answers questions about Flui. After several questions on other topics it pauses for a while; try again in ${Math.ceil(seconds / 60)} minutes.`,
      seconds,
    );
  }

  private async assertInstanceDailyCap(
    limits: GuestInferenceLimits,
    now: Date,
    visitor: boolean,
  ): Promise<void> {
    if (!limits.instanceDailyTokens) return;
    const dayStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const spent = await this.usage.guestTotalSince(dayStart);
    if (spent < limits.instanceDailyTokens) return;
    throw tooMany(
      GUEST_INFERENCE_CODE.DAILY_CAP,
      `The demo has used today's assistant time for all guests. It comes back at midnight UTC. ${stillWorks(visitor)}`,
      Math.ceil((dayStart.getTime() + DAY_MS - now.getTime()) / 1000),
    );
  }

  private async assertAddressCap(
    ipHash: string | null,
    limits: GuestInferenceLimits,
    now: Date,
    visitor: boolean,
  ): Promise<void> {
    if (!limits.ipDailyTokens || !ipHash) return;
    const spent = await this.usage.tokensForAddress(
      ipHash,
      new Date(now.getTime() - DAY_MS),
    );
    if (spent < limits.ipDailyTokens) return;
    throw tooMany(
      GUEST_INFERENCE_CODE.ADDRESS_CAP,
      `The assistant time for your network is used up for today. ${stillWorks(visitor)}`,
    );
  }
}

function tooMany(
  code: string,
  message: string,
  retryAfterSeconds?: number,
): HttpException {
  return new HttpException(
    {
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      code,
      message,
      ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}
