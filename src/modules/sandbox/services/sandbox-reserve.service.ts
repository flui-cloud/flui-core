import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import {
  SandboxTenantEntity,
  SandboxTenantState,
} from '../entities/sandbox-tenant.entity';
import { SANDBOX_CONFIG, SandboxConfig } from '../sandbox.config';

/**
 * The area table and the operations on it: finding the ones past their
 * deadline, and making sure every one of them dies on time. Handing an area to
 * a guest is the gate's job (`SandboxSlotGateService`), a single conditional
 * update so two first deploys never share one.
 */
@Injectable()
export class SandboxReserveService {
  private readonly logger = new Logger(SandboxReserveService.name);

  constructor(
    @InjectRepository(SandboxTenantEntity)
    private readonly tenants: Repository<SandboxTenantEntity>,
    @Inject(SANDBOX_CONFIG) private readonly config: SandboxConfig,
  ) {}

  /** Every area somebody is holding right now. */
  async findClaimed(limit = 200, skip = 0): Promise<SandboxTenantEntity[]> {
    return this.tenants.find({
      where: { state: SandboxTenantState.CLAIMED },
      order: { claimedAt: 'ASC', id: 'ASC' },
      take: limit,
      skip,
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
    return this.tenants.save(
      this.tenants.create({
        state: SandboxTenantState.PROVISIONING,
        // A placeholder until the area's project exists. Outside the `p-`
        // space on purpose, so it can never name a project's namespace.
        namespace: `sandbox-pending-${suffix}`,
        clusterId,
        email: null,
      }),
    );
  }

  /** The project the area is, written as soon as it exists so a failed build can be cleaned up. */
  async recordArea(
    id: string,
    fields: { namespace: string; projectId: string },
  ): Promise<void> {
    await this.tenants.update(id, fields);
  }

  async markReady(id: string): Promise<void> {
    await this.tenants.update(id, {
      state: SandboxTenantState.READY,
      lastError: null,
    });
  }

  async markWarned(id: string, at: Date): Promise<void> {
    await this.tenants.update(id, { expiryWarnedAt: at });
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
        attempts >= this.config.reapAttemptsBeforeHelp
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
