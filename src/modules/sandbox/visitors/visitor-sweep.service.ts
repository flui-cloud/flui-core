import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';
import { USER_KIND, UserEntity } from '../../auth/entities/user.entity';
import { ApiKeyEntity } from '../../auth/entities/api-key.entity';
import { IamRoleBindingEntity } from '../../iam/entities/iam-role-binding.entity';
import { ActionProposalEntity } from '../../action-cycle/entities/action-proposal.entity';
import { AgentConcessionEntity } from '../../action-cycle/entities/agent-concession.entity';
import {
  IDENTITY_DIRECTORY,
  IIdentityDirectory,
} from '../../auth/interfaces/identity-directory.interface';
import { ProjectsService } from '../../projects/projects.service';
import { describeError } from '../../shared/utils/error.util';
import { SandboxVisitorEntity } from '../entities/sandbox-visitor.entity';
import { VisitorAdmissionService } from './visitor-admission.service';
import { lockVisitor } from './visitor-fold';
import { VISITOR_CONFIG, VisitorConfig } from './visitor.config';
import { accessGrantsChanged } from '../../iam/services/access-grants-changed';

export const VISITOR_SWEEP_PAGE = 50;

/**
 * Visitors who never signed in go: after `idleHours` without a visit, or
 * `maxHours` after they arrived, whichever comes first. Everything they had
 * goes with them, here and at the identity provider, except what inference
 * cost, which stays in the ledger, and their keys, revoked and kept so a CLI
 * still holding one hears that the visit ended. Their visitor row stays,
 * marked removed, so a token issued before can never make them again. A
 * visitor that became an account is never touched.
 */
@Injectable()
export class VisitorSweepService {
  private readonly logger = new Logger(VisitorSweepService.name);

  constructor(
    @Inject(VISITOR_CONFIG) private readonly config: VisitorConfig,
    @InjectRepository(SandboxVisitorEntity)
    private readonly visitors: Repository<SandboxVisitorEntity>,
    private readonly dataSource: DataSource,
    @Inject(IDENTITY_DIRECTORY) private readonly directory: IIdentityDirectory,
    private readonly projects: ProjectsService,
    private readonly admissions: VisitorAdmissionService,
  ) {}

  async sweep(now = new Date()): Promise<number> {
    await this.admissions.purgeExpired(now);
    const due = await this.visitors
      .createQueryBuilder('v')
      .innerJoinAndSelect('v.user', 'u')
      .where('"v"."upgradedAt" IS NULL')
      .andWhere('"v"."removedAt" IS NULL')
      .andWhere('"u"."kind" = :kind', { kind: USER_KIND.VISITOR })
      .andWhere('"u"."isAdmin" = false')
      .andWhere(
        '(COALESCE("u"."lastSeenAt", "u"."createdAt") < :idle OR "u"."createdAt" < :max)',
        {
          idle: new Date(now.getTime() - this.config.idleMs),
          max: new Date(now.getTime() - this.config.maxMs),
        },
      )
      .orderBy('"u"."createdAt"', 'ASC')
      .limit(VISITOR_SWEEP_PAGE)
      .getMany();

    let removed = 0;
    for (const visitor of due) {
      try {
        if (await this.remove(visitor.userId, now)) removed += 1;
      } catch (error) {
        this.logger.warn(
          `Could not remove visitor ${visitor.userId}: ${describeError(error)}`,
        );
      }
    }
    if (removed > 0) this.logger.log(`Removed ${removed} visitor(s) who left`);
    return removed;
  }

  /**
   * Under the same row lock an upgrade takes, so a visitor turning into an
   * account at this very moment is either upgraded or removed, never both.
   */
  private async remove(userId: string, now: Date): Promise<boolean> {
    const done = await this.dataSource.transaction(async (m) => {
      const visitor = await lockVisitor(m, userId);
      if (!visitor || visitor.isAdmin) return false;
      const row = await m.getRepository(SandboxVisitorEntity).findOne({
        where: { userId, upgradedAt: IsNull(), removedAt: IsNull() },
      });
      if (!row) return false;
      await this.forget(m, userId);
      await this.directory.deleteUser(row.idpUserId).catch((error: unknown) => {
        if (!(error instanceof NotFoundException)) throw error;
      });
      await m
        .getRepository(SandboxVisitorEntity)
        .update({ userId }, { removedAt: now, ipHash: null });
      await m
        .getRepository(UserEntity)
        .delete({ id: userId, kind: USER_KIND.VISITOR });
      return true;
    });
    if (done) {
      await this.projects
        .removePersonal(userId)
        .catch((error: unknown) =>
          this.logger.warn(
            `Removed visitor ${userId}: personal project left behind: ${describeError(error)}`,
          ),
        );
    }
    return done;
  }

  private async forget(m: EntityManager, userId: string): Promise<void> {
    await m
      .getRepository(ApiKeyEntity)
      .update({ userId, revoked: false }, { revoked: true });
    await m
      .getRepository(IamRoleBindingEntity)
      .delete({ principalType: 'user', principalRef: userId });
    accessGrantsChanged();
    await m.getRepository(ActionProposalEntity).delete({ ownerUserId: userId });
    await m
      .getRepository(AgentConcessionEntity)
      .delete({ ownerUserId: userId });
  }
}
