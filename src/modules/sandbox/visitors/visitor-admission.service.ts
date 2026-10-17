import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, MoreThan, Repository } from 'typeorm';
import { createHash, randomBytes } from 'node:crypto';
import { ThrottlerStorage } from '@nestjs/throttler';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { SandboxVisitorAdmissionEntity } from '../entities/sandbox-visitor-admission.entity';
import { SandboxVisitorEntity } from '../entities/sandbox-visitor.entity';
import { describeError } from '../../shared/utils/error.util';
import { hashIp } from './visitor-ip';
import { Fetch, verifyTurnstile } from './turnstile';
import { VISITOR_CONFIG, VisitorConfig } from './visitor.config';
import {
  VISITOR_REFUSAL,
  VisitorRefusalReason,
  VisitorRefusalsService,
} from './visitor-refusals.service';

export const VISITOR_THROTTLER = 'SANDBOX_VISITOR_THROTTLER';
export const VISITOR_FETCH = 'SANDBOX_VISITOR_FETCH';

export const VISITORS_CLOSED_CODE = 'SANDBOX_VISITORS_CLOSED';
export const VISITORS_LIMIT_CODE = 'SANDBOX_VISITORS_LIMIT';
export const VISITOR_CHALLENGE_FAILED_CODE = 'SANDBOX_VISITOR_CHALLENGE_FAILED';

const ADMISSION_TTL_MS = 2 * 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const THROTTLER_NAME = 'sandbox-visitors';

export interface Admission {
  nonce: string;
  expiresInSeconds: number;
}

export interface AdmissionRequest {
  ip: string;
  turnstileToken?: string;
  cli?: boolean;
}

/**
 * The door before the door: a visitor gets a single-use ticket, counted
 * against its address and against everyone, and checked by Turnstile when the
 * instance has a key for it. The ticket is what the sign-in endpoint asks for.
 */
@Injectable()
export class VisitorAdmissionService {
  private readonly logger = new Logger(VisitorAdmissionService.name);
  private warnedNoChallenge = false;
  private ipKey: Buffer | string | null = null;

  constructor(
    @Inject(VISITOR_CONFIG) private readonly config: VisitorConfig,
    @InjectRepository(SandboxVisitorAdmissionEntity)
    private readonly admissions: Repository<SandboxVisitorAdmissionEntity>,
    private readonly encryption: EncryptionService,
    @Inject(VISITOR_THROTTLER) private readonly throttler: ThrottlerStorage,
    @Inject(VISITOR_FETCH) private readonly fetchImpl: Fetch,
    @InjectRepository(SandboxVisitorEntity)
    private readonly visitors: Repository<SandboxVisitorEntity>,
    private readonly refusals: VisitorRefusalsService,
  ) {}

  hashIp(ip: string): string {
    this.ipKey ??=
      this.config.ipHashKey ??
      this.encryption.deriveSubkey('sandbox.visitor.ip-hash');
    return hashIp(ip, this.ipKey);
  }

  async admit(request: AdmissionRequest): Promise<Admission> {
    if (!this.config.enabled) {
      await this.refusals.note(VISITOR_REFUSAL.CLOSED);
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: VISITORS_CLOSED_CODE,
        message: 'The demo is not taking visitors right now.',
      });
    }
    const ipHash = this.hashIp(request.ip);
    await this.count(
      `ip:${ipHash}`,
      HOUR_MS,
      this.config.perIpHour,
      VISITOR_REFUSAL.LIMIT_IP,
    );
    if (request.cli) {
      await this.count(
        `cli-ip:${ipHash}`,
        HOUR_MS,
        this.config.cliPerIpHour,
        VISITOR_REFUSAL.LIMIT_CLI,
      );
    }
    await this.count(
      'global',
      60_000,
      this.config.globalPerMinute,
      VISITOR_REFUSAL.LIMIT_GLOBAL,
    );
    await this.checkDay();
    if (!request.cli) await this.challenge(request);

    const nonce = randomBytes(32).toString('base64url');
    await this.admissions.insert({
      nonceHash: digest(nonce),
      ipHash,
      cli: request.cli === true,
      expiresAt: new Date(Date.now() + ADMISSION_TTL_MS),
    });
    return { nonce, expiresInSeconds: ADMISSION_TTL_MS / 1000 };
  }

  /** Takes the ticket, once: its address hash, or null when it is unknown, used, expired or for the other client. */
  async consume(
    nonce: string | null | undefined,
    cli: boolean,
  ): Promise<{ ipHash: string } | null> {
    if (!nonce || nonce.length > 128) return null;
    const result = await this.admissions
      .createQueryBuilder()
      .delete()
      .where('"nonceHash" = :hash', { hash: digest(nonce) })
      .andWhere('"expiresAt" > :now', { now: new Date() })
      .andWhere('"cli" = :cli', { cli })
      .returning(['ipHash'])
      .execute();
    const row = (result.raw as Array<{ ipHash: string }> | undefined)?.[0];
    return row ? { ipHash: row.ipHash } : null;
  }

  async purgeExpired(now = new Date()): Promise<number> {
    const result = await this.admissions.delete({ expiresAt: LessThan(now) });
    return result.affected ?? 0;
  }

  private async count(
    key: string,
    ttlMs: number,
    limit: number,
    reason: VisitorRefusalReason,
  ): Promise<void> {
    const record = await this.throttler.increment(
      key,
      ttlMs,
      limit,
      0,
      THROTTLER_NAME,
    );
    if (record.totalHits > limit) await this.tooMany(reason);
  }

  private async checkDay(): Promise<void> {
    const made = await this.visitors.count({
      where: { createdAt: MoreThan(new Date(Date.now() - DAY_MS)) },
    });
    if (made >= this.config.globalPerDay) {
      await this.tooMany(VISITOR_REFUSAL.LIMIT_DAY);
    }
  }

  private async tooMany(reason: VisitorRefusalReason): Promise<never> {
    await this.refusals.note(reason);
    throw new HttpException(
      {
        statusCode: 429,
        code: VISITORS_LIMIT_CODE,
        message: 'Too many visitors right now. Try again in a little while.',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private async challenge(request: AdmissionRequest): Promise<void> {
    const secret = this.config.turnstileSecret;
    if (!secret) {
      if (!this.warnedNoChallenge) {
        this.logger.warn(
          'TURNSTILE_SECRET_KEY is not set: visitors are admitted without a browser check',
        );
        this.warnedNoChallenge = true;
      }
      return;
    }
    const token = request.turnstileToken?.trim();
    let passed = false;
    if (token) {
      passed = await verifyTurnstile(
        secret,
        token,
        request.ip,
        this.fetchImpl,
      ).catch((error: unknown) => {
        this.logger.warn(`Turnstile did not answer: ${describeError(error)}`);
        return false;
      });
    }
    if (!passed) {
      await this.refusals.note(VISITOR_REFUSAL.CHALLENGE);
      throw new ForbiddenException({
        statusCode: 403,
        code: VISITOR_CHALLENGE_FAILED_CODE,
        message:
          'Your browser could not be checked. Reload the page to try again.',
      });
    }
  }
}

function digest(nonce: string): string {
  return createHash('sha256').update(nonce).digest('hex');
}
