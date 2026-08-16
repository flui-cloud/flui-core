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

export interface ClaimResult {
  tenant: SandboxTenantEntity;
  expiresAt: Date;
}

/**
 * The reserve: keeping enough warm tenancies that a click assigns instead of
 * creating, and making sure every one of them dies on time.
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

    throw new ServiceUnavailableException({
      statusCode: 503,
      code: 'SANDBOX_FULL',
      message:
        'Every sandbox is taken right now. They are released continuously — try again in a few minutes.',
    });
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
    };
    for (const row of rows) out[row.state] = Number(row.count);
    return out;
  }

  /** How many tenancies to build right now to refill the reserve. */
  async missingFromReserve(): Promise<number> {
    const counts = await this.countByState();
    return Math.max(
      0,
      this.config.reserveSize - counts[SandboxTenantState.READY],
    );
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

  async markFailed(id: string, error: string): Promise<void> {
    await this.tenants.update(id, {
      state: SandboxTenantState.FAILED,
      lastError: error.slice(0, 2000),
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
