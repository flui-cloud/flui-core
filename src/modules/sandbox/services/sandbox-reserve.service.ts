import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { createHash, randomUUID } from 'node:crypto';
import { buildUserNamespace } from '../../applications/utils/k8s-namespace.util';
import {
  SandboxTenantEntity,
  SandboxTenantState,
} from '../entities/sandbox-tenant.entity';
import { SANDBOX_CONFIG, SandboxConfig } from '../sandbox.config';
import { SandboxCapacityService } from './sandbox-capacity.service';

/**
 * How many sweeps ending in the *same* error a tenancy gets before it stops
 * being retried. The reaper runs every minute, so this is three minutes of
 * proving the failure is not transient — long enough for a provider hiccup or
 * a restarting API to pass, short enough that the log does not fill up.
 */
export const REAP_ATTEMPTS_BEFORE_HELP = 3;

export interface ClaimResult {
  tenant: SandboxTenantEntity;
  expiresAt: Date;
}

/**
 * The tenancy table and the operations on it: handing one out, finding the ones
 * that are past their deadline, and making sure every one of them dies on time.
 *
 * Warm tenancies exist so that a click *assigns* instead of *creating* — a
 * build takes two minutes, and the entrance promises three seconds. How many to
 * keep warm is not decided here and is not a setting; see
 * {@link SandboxCapacityService}.
 *
 * Claiming is the one operation that must never be sloppy. Two visitors landing
 * in the same millisecond must not receive the same tenancy, so the claim is a
 * single conditional UPDATE — the database picks the winner, not the process.
 */
@Injectable()
export class SandboxReserveService {
  private readonly logger = new Logger(SandboxReserveService.name);

  constructor(
    @InjectRepository(SandboxTenantEntity)
    private readonly tenants: Repository<SandboxTenantEntity>,
    private readonly capacity: SandboxCapacityService,
    @Inject(SANDBOX_CONFIG) private readonly config: SandboxConfig,
  ) {}

  /** Addresses are never stored raw: the limit needs a counter, not an identity. */
  hashIp(ip: string): string {
    return createHash('sha256')
      .update(`${this.config.ipHashSalt}:${ip}`)
      .digest('hex')
      .slice(0, 32);
  }

  async countRecentClaimsFrom(ip: string): Promise<number> {
    const since = new Date(Date.now() - this.config.claimWindowMs);
    return this.tenants
      .createQueryBuilder('t')
      .where('t."claimIpHash" = :hash', { hash: this.hashIp(ip) })
      .andWhere('t."claimedAt" > :since', { since })
      .getCount();
  }

  /**
   * Hand one warm tenancy to a visitor. Returns the row only if this call is the
   * one that flipped it — a second caller racing for the same row updates zero
   * rows and tries the next one.
   */
  async claim(ip: string): Promise<ClaimResult> {
    const recent = await this.countRecentClaimsFrom(ip);
    if (recent >= this.config.maxClaimsPerIp) {
      throw new ConflictException({
        statusCode: 409,
        code: 'SANDBOX_CLAIM_LIMIT',
        message: `This address has already opened ${recent} sandboxes today. They last ${this.config.ttlHours} hours — carry on in the one you have.`,
      });
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.config.ttlMs);

    // Bounded retry: each miss means somebody else won that row, and there is no
    // point looping longer than the reserve is deep.
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = await this.tenants.findOne({
        where: { state: SandboxTenantState.READY },
        order: { createdAt: 'ASC' },
      });
      if (!candidate) break;

      const result = await this.tenants
        .createQueryBuilder()
        .update(SandboxTenantEntity)
        .set({
          state: SandboxTenantState.CLAIMED,
          claimedAt: now,
          expiresAt,
          claimIpHash: this.hashIp(ip),
        })
        .where('id = :id AND state = :ready', {
          id: candidate.id,
          ready: SandboxTenantState.READY,
        })
        .execute();

      if (result.affected === 1) {
        this.logger.log(
          `Sandbox ${candidate.namespace} claimed, expires ${expiresAt.toISOString()}`,
        );
        return {
          tenant: await this.tenants.findOneByOrFail({ id: candidate.id }),
          expiresAt,
        };
      }
    }

    // Counted, not just refused. How often the door is closed is the one signal
    // that says the buffer is sized too small, and it is invisible from the
    // tenancy table: nobody who was turned away leaves a row behind.
    this.capacity.recordFullRefusal();
    throw new ServiceUnavailableException({
      statusCode: 503,
      code: 'SANDBOX_FULL',
      message: await this.whenToComeBack(),
    });
  }

  /**
   * Two different "full", and telling them apart is the difference between a
   * useful sentence and a brush-off.
   *
   * If the cluster still has room, one is already being built and the wait is a
   * few minutes — say the number, because a visitor who knows it will wait.
   * If the cluster is at its ceiling, nothing is being built and the wait is for
   * somebody else to leave, which is hours; promising minutes there would be a
   * lie that costs the visit anyway.
   */
  private async whenToComeBack(): Promise<string> {
    try {
      const { ceiling, live, warm, readySeconds } =
        await this.capacity.snapshot();
      if (ceiling > live + warm) {
        const minutes = Math.max(1, Math.ceil(readySeconds / 60));
        return `Every sandbox is taken right now. Another is being built — try again in about ${minutes} minutes.`;
      }
      return `This instance is running as many sandboxes as it can hold. They are released as their ${this.config.ttlHours} hours run out, so a slot opens through the day — try again later.`;
    } catch {
      // Never let the shape of the refusal depend on a working cluster read.
      return 'Every sandbox is taken right now. They are released continuously — try again in a few minutes.';
    }
  }

  /** Tenancies whose deadline has passed. The reaper's work list. */
  async findExpired(limit = 20): Promise<SandboxTenantEntity[]> {
    return this.tenants.find({
      where: {
        state: SandboxTenantState.CLAIMED,
        expiresAt: LessThan(new Date()),
      },
      order: { expiresAt: 'ASC' },
      take: limit,
    });
  }

  /**
   * Tenancies built but never taken, older than the recycle age. They are torn
   * down and rebuilt rather than left forever: a warm tenancy that has been
   * sitting for days is warm in name only — its seeded data has aged out of the
   * story the demo tells.
   */
  async findStale(limit = 20): Promise<SandboxTenantEntity[]> {
    return this.tenants.find({
      where: {
        state: SandboxTenantState.READY,
        createdAt: LessThan(
          new Date(Date.now() - this.config.recycleUnclaimedMs),
        ),
      },
      order: { createdAt: 'ASC' },
      take: limit,
    });
  }

  /**
   * Rows the reaper must collect besides expired ones: tenancies that broke
   * while being built, and tenancies still claiming to be under construction
   * long after any build could plausibly still be running. Both hold a
   * namespace and an identity-provider account that nothing else will free.
   */
  async findAbandoned(limit = 20): Promise<SandboxTenantEntity[]> {
    const stuckSince = new Date(Date.now() - this.config.provisionStuckMs);
    return this.tenants.find({
      where: [
        { state: SandboxTenantState.FAILED },
        {
          state: SandboxTenantState.PROVISIONING,
          createdAt: LessThan(stuckSince),
        },
      ],
      order: { createdAt: 'ASC' },
      take: limit,
    });
  }

  /** Every tenancy the instance knows about, newest first. */
  async listAll(limit = 200): Promise<SandboxTenantEntity[]> {
    return this.tenants.find({
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  /**
   * One tenancy, by id or by namespace. A namespace is what an operator has in
   * front of them — in a log line, in a listing — so it is accepted here rather
   * than translated by hand into an id.
   */
  async findOneByRef(ref: string): Promise<SandboxTenantEntity | null> {
    const byNamespace = await this.tenants.findOne({
      where: { namespace: ref },
    });
    if (byNamespace) return byNamespace;
    // An id lookup on a non-uuid string is a database error, not a miss.
    if (!/^[0-9a-f-]{36}$/i.test(ref)) return null;
    return this.tenants.findOne({ where: { id: ref } });
  }

  async getById(id: string): Promise<SandboxTenantEntity> {
    const found = await this.tenants.findOne({ where: { id } });
    if (!found) throw new Error(`Sandbox tenancy ${id} no longer exists`);
    return found;
  }

  async countByState(): Promise<Record<SandboxTenantState, number>> {
    const rows = await this.tenants
      .createQueryBuilder('t')
      .select('t.state', 'state')
      .addSelect('COUNT(*)', 'count')
      .groupBy('t.state')
      .getRawMany<{ state: SandboxTenantState; count: string }>();

    const out = {
      [SandboxTenantState.PROVISIONING]: 0,
      [SandboxTenantState.READY]: 0,
      [SandboxTenantState.CLAIMED]: 0,
      [SandboxTenantState.EXPIRED]: 0,
      [SandboxTenantState.FAILED]: 0,
      [SandboxTenantState.NEEDS_ATTENTION]: 0,
    };
    for (const row of rows) out[row.state] = Number(row.count);
    return out;
  }

  async createPending(clusterId: string): Promise<SandboxTenantEntity> {
    const suffix = randomUUID().split('-')[0];
    const email = `${this.config.emailPrefix}-${suffix}@${this.config.emailDomain}`;
    return this.tenants.save(
      this.tenants.create({
        state: SandboxTenantState.PROVISIONING,
        // Derived, never chosen: the catalogue installer computes a namespace
        // from the owner's email, so a name picked here would leave the seeded
        // applications outside the quota and network policy applied to it.
        namespace: buildUserNamespace(email),
        clusterId,
        email,
      }),
    );
  }

  /**
   * Write down who this tenancy belongs to the moment those identities exist,
   * not when it goes ready. Everything between costs minutes — the seed alone
   * can run for ten — and a failure in that window used to leave a row that no
   * longer knew which identity-provider account to delete, so the account
   * outlived the tenancy with nothing left pointing at it.
   */
  async recordIdentities(
    id: string,
    fields: { userId: string; idpUserId: string },
  ): Promise<void> {
    await this.tenants.update(id, fields);
  }

  async markReady(
    id: string,
    fields: { userId: string; idpUserId: string },
  ): Promise<void> {
    await this.tenants.update(id, {
      ...fields,
      state: SandboxTenantState.READY,
      lastError: null,
    });
  }

  async markExpired(id: string): Promise<void> {
    await this.tenants.update(id, {
      state: SandboxTenantState.EXPIRED,
      reapedAt: new Date(),
      lastError: null,
    });
  }

  /**
   * Records a failed sweep, and decides whether it is still worth sweeping.
   *
   * The counter only counts *repeats*: a different error resets it, because a
   * different failure means something moved and the next attempt is not the
   * same attempt. Three identical ones — three minutes of the same line in the
   * log — is a standing condition, not a flake, and no number of further
   * retries will change it. The row parks in NEEDS_ATTENTION, out of the
   * sweep, where the hourly report can see it.
   */
  async markFailed(id: string, error: string): Promise<void> {
    const message = error.slice(0, 2000);
    const current = await this.tenants.findOne({
      where: { id },
      select: { id: true, lastError: true, reapAttempts: true },
    });
    const repeated = current?.lastError === message;
    const attempts = repeated ? (current?.reapAttempts ?? 0) + 1 : 1;

    await this.tenants.update(id, {
      state:
        attempts >= REAP_ATTEMPTS_BEFORE_HELP
          ? SandboxTenantState.NEEDS_ATTENTION
          : SandboxTenantState.FAILED,
      lastError: message,
      reapAttempts: attempts,
    });
  }

  async findActiveForUser(userId: string): Promise<SandboxTenantEntity | null> {
    return this.tenants.findOne({
      where: { userId, state: SandboxTenantState.CLAIMED },
    });
  }

  async remove(id: string): Promise<void> {
    await this.tenants.delete(id);
  }
}
