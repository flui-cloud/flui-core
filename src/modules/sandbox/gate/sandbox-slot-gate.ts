import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  Module,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { IsNull, LessThan, MoreThan, Not, Repository } from 'typeorm';
import { SandboxWaitlistEntity } from '../entities/sandbox-waitlist.entity';
import { isPlaceholderEmail } from '../../auth/utils/placeholder-email.util';
import { ProjectEntity } from '../../projects/entities/project.entity';
import {
  SandboxTenantEntity,
  SandboxTenantState,
} from '../entities/sandbox-tenant.entity';
import {
  SANDBOX_CONFIG,
  SandboxConfig,
  isRefusedEmail,
  loadSandboxConfig,
} from '../sandbox.config';
import { IamRoleBindingEntity } from '../../iam/entities/iam-role-binding.entity';
import {
  SANDBOX_GUEST_ENROLMENT,
  SandboxGuestEnrolmentService,
} from './sandbox-guest-enrolment';
import { SANDBOX_ACTIVITY, SandboxActivityService } from './sandbox-activity';

export const SANDBOX_SLOT_GATE = 'SANDBOX_SLOT_GATE';

/** Where a guest's work may go. Asked before anything a guest creates is written. */
export interface SandboxSlotGate {
  assertCanCreate(
    userId: string,
    clusterId: string | undefined,
    email?: string | null,
  ): Promise<void>;
  /** End the person's area now; the reaper takes it apart on its next pass. */
  releaseAreaOf(userId: string): Promise<void>;
}

export const SANDBOX_CLUSTER_FORBIDDEN_CODE = 'SANDBOX_CLUSTER_NOT_OWNED';
export const SANDBOX_CLOSED_CODE = 'SANDBOX_CLOSED';
export const SANDBOX_FULL_CODE = 'SANDBOX_FULL';
export const SANDBOX_BUILDING_CODE = 'SANDBOX_BUILDING';
export const SANDBOX_EMAIL_REFUSED_CODE = 'SANDBOX_EMAIL_REFUSED';

/**
 * The door to a guest's own area. Looking around costs nothing and needs no
 * area; the first thing a guest deploys takes one, if there is one to take.
 *
 * Kept in its own small module so that the creation path can ask it without
 * the applications module depending on the sandbox module, which depends on
 * the applications module. For the same reason it hands out areas the
 * reserve has already built and never builds one itself.
 */
@Injectable()
export class SandboxSlotGateService implements SandboxSlotGate {
  private readonly logger = new Logger(SandboxSlotGateService.name);

  constructor(
    @InjectRepository(SandboxTenantEntity)
    private readonly tenants: Repository<SandboxTenantEntity>,
    @InjectRepository(ProjectEntity)
    private readonly projects: Repository<ProjectEntity>,
    @Inject(SANDBOX_CONFIG) private readonly config: SandboxConfig,
    @InjectRepository(SandboxWaitlistEntity)
    private readonly waitlist: Repository<SandboxWaitlistEntity>,
  ) {}

  async assertCanCreate(
    userId: string,
    clusterId: string | undefined,
    email?: string | null,
  ): Promise<void> {
    const held = await this.tenants.findOne({
      where: { userId, state: SandboxTenantState.CLAIMED },
    });
    if (held) {
      if (held.clusterId !== clusterId) throw this.notOwned(clusterId);
      return;
    }

    if (!this.config.acceptingClaims) {
      throw new ForbiddenException({
        statusCode: 403,
        code: SANDBOX_CLOSED_CODE,
        message:
          'The demo is not handing out new spaces at the moment. You can keep looking around.',
      });
    }
    if (!clusterId || clusterId !== this.config.clusterId) {
      throw this.notOwned(clusterId);
    }
    if (isRefusedEmail(email, this.config.refusedEmailDomains)) {
      throw new ForbiddenException({
        statusCode: 403,
        code: SANDBOX_EMAIL_REFUSED_CODE,
        message:
          'Deploying in the demo needs a permanent email address. Sign in with GitHub, Google or another address to get a space; you can keep looking around.',
      });
    }

    const now = new Date();
    const mine = await this.waitlist.findOne({ where: { userId } });
    const offeredToMe =
      !!mine?.offerExpiresAt && mine.offerExpiresAt.getTime() > now.getTime();
    if (!offeredToMe) {
      const inUse = await this.tenants.count({
        where: { state: SandboxTenantState.CLAIMED },
      });
      const held = await this.waitlist.count({
        where: { offerExpiresAt: MoreThan(now) },
      });
      if (inUse + held >= this.config.maxSlots) {
        throw await this.full(userId, email ?? null, mine);
      }
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = await this.tenants.findOne({
        where: {
          state: SandboxTenantState.READY,
          clusterId,
          projectId: Not(IsNull()),
        },
        order: { createdAt: 'ASC' },
      });
      if (!candidate) break;
      if (await this.take(candidate, userId, email ?? null)) {
        await this.waitlist.delete({ userId });
        return;
      }
    }

    throw new ServiceUnavailableException({
      statusCode: 503,
      code: SANDBOX_BUILDING_CODE,
      message: 'Your space is being prepared. Try again in a minute.',
    });
  }

  /**
   * One conditional update decides who gets the area, so two first deploys
   * at once never share one. The project becomes the guest's personal one,
   * which is where their applications are placed from then on.
   */
  private async take(
    area: SandboxTenantEntity,
    userId: string,
    email: string | null,
  ): Promise<boolean> {
    // An area built before areas were projects has none to hand over, and an
    // update with no id is an update of every project nobody owns.
    if (!area.projectId) return false;
    const now = new Date();
    const result = await this.tenants
      .createQueryBuilder()
      .update(SandboxTenantEntity)
      .set({
        state: SandboxTenantState.CLAIMED,
        userId,
        email,
        claimedAt: now,
        expiresAt: new Date(now.getTime() + this.config.ttlMs),
      })
      .where('id = :id AND state = :ready', {
        id: area.id,
        ready: SandboxTenantState.READY,
      })
      .execute();
    if (result.affected !== 1) return false;

    try {
      await this.projects.update(
        { id: area.projectId, ownerUserId: IsNull() },
        { ownerUserId: userId },
      );
    } catch (error) {
      await this.tenants.update(area.id, {
        state: SandboxTenantState.READY,
        userId: null,
        email: null,
        claimedAt: null,
        expiresAt: null,
      });
      throw error;
    }
    this.logger.log(`Area ${area.namespace} handed to ${userId}`);
    return true;
  }

  /**
   * Every space is in use: the guest joins the waiting list, once, and is told
   * where they stand. They keep looking around meanwhile.
   */
  private async full(
    userId: string,
    email: string | null,
    mine: SandboxWaitlistEntity | null,
  ): Promise<ServiceUnavailableException> {
    let entry = mine;
    if (!entry) {
      try {
        entry = await this.waitlist.save(
          this.waitlist.create({ userId, email }),
        );
      } catch {
        entry = await this.waitlist.findOne({ where: { userId } });
      }
    }
    const ahead = entry
      ? await this.waitlist.count({
          where: { createdAt: LessThan(entry.createdAt) },
        })
      : 0;
    const reachable = !!email && !isPlaceholderEmail(email);
    return new ServiceUnavailableException({
      statusCode: 503,
      code: SANDBOX_FULL_CODE,
      position: ahead + 1,
      message:
        `Every demo space is in use right now. You are number ${ahead + 1} on the waiting list` +
        (reachable
          ? '; we will email you when a space is free for you.'
          : '; try again later.') +
        ' You can keep looking around meanwhile.',
    });
  }

  async releaseAreaOf(userId: string): Promise<void> {
    await this.tenants.update(
      { userId, state: SandboxTenantState.CLAIMED },
      { expiresAt: new Date() },
    );
    await this.waitlist.delete({ userId });
  }

  private notOwned(clusterId: string | undefined): ForbiddenException {
    return new ForbiddenException({
      statusCode: 403,
      code: SANDBOX_CLUSTER_FORBIDDEN_CODE,
      message:
        'A demo guest can only create applications on the cluster of the demo.',
      clusterId: clusterId ?? null,
    });
  }
}

@Module({
  imports: [
    TypeOrmModule.forFeature([
      SandboxTenantEntity,
      SandboxWaitlistEntity,
      IamRoleBindingEntity,
      ProjectEntity,
    ]),
  ],
  providers: [
    { provide: SANDBOX_CONFIG, useFactory: () => loadSandboxConfig() },
    SandboxSlotGateService,
    { provide: SANDBOX_SLOT_GATE, useExisting: SandboxSlotGateService },
    SandboxGuestEnrolmentService,
    {
      provide: SANDBOX_GUEST_ENROLMENT,
      useExisting: SandboxGuestEnrolmentService,
    },
    SandboxActivityService,
    { provide: SANDBOX_ACTIVITY, useExisting: SandboxActivityService },
  ],
  exports: [SANDBOX_SLOT_GATE, SANDBOX_GUEST_ENROLMENT, SANDBOX_ACTIVITY],
})
export class SandboxGateModule {}
