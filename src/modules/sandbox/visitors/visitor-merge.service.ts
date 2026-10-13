import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { UserEntity } from '../../auth/entities/user.entity';
import {
  IDENTITY_DIRECTORY,
  IIdentityDirectory,
} from '../../auth/interfaces/identity-directory.interface';
import { AuditService } from '../../audit/audit.service';
import { ProjectsService } from '../../projects/projects.service';
import { describeError } from '../../shared/utils/error.util';
import {
  SANDBOX_GUEST_ENROLMENT,
  SandboxGuestEnrolment,
} from '../gate/sandbox-guest-enrolment';
import {
  VisitorProfileChange,
  flipVisitorToPerson,
  foldVisitorInto,
  lockVisitor,
} from './visitor-fold';

export type VisitorMergeVia = 'github' | 'google' | 'email';

export interface MergeResult {
  done: boolean;
  guest?: boolean;
  reason?: 'gone' | 'blocked';
}

/**
 * The two ways a visitor stops being one, each a single transaction on Flui's
 * side: it becomes a person on the same row, or it is merged into an account
 * that already exists. Both are recorded in the audit log as done by the
 * visitor, with the account it went into as the target.
 */
@Injectable()
export class VisitorMergeService {
  private readonly logger = new Logger(VisitorMergeService.name);

  constructor(
    private readonly dataSource: DataSource,
    @Inject(SANDBOX_GUEST_ENROLMENT)
    private readonly enrolment: SandboxGuestEnrolment,
    @Inject(IDENTITY_DIRECTORY) private readonly directory: IIdentityDirectory,
    private readonly projects: ProjectsService,
    private readonly audit: AuditService,
  ) {}

  async flip(
    visitorUserId: string,
    change: VisitorProfileChange,
    via: VisitorMergeVia,
    now = new Date(),
  ): Promise<MergeResult> {
    const result = await this.dataSource.transaction(
      async (m): Promise<MergeResult> => {
        const visitor = await lockVisitor(m, visitorUserId);
        if (!visitor) return { done: false, reason: 'gone' };
        if (visitor.blockedAt) return { done: false, reason: 'blocked' };
        const { guest } = await flipVisitorToPerson(
          m,
          this.enrolment,
          visitor,
          change,
          now,
        );
        return { done: true, guest };
      },
    );
    await this.record(
      'sandbox.visitor.upgrade',
      visitorUserId,
      null,
      via,
      result,
    );
    return result;
  }

  async fold(
    visitorUserId: string,
    target: Pick<UserEntity, 'id' | 'email'>,
    via: VisitorMergeVia,
    now = new Date(),
  ): Promise<MergeResult> {
    let idpUserId: string | null = null;
    const result = await this.dataSource.transaction(
      async (m): Promise<MergeResult> => {
        const visitor = await lockVisitor(m, visitorUserId);
        if (!visitor) return { done: false, reason: 'gone' };
        if (visitor.blockedAt) return { done: false, reason: 'blocked' };
        idpUserId = visitor.oidcSub;
        await foldVisitorInto(m, visitor, target.id, now);
        return { done: true };
      },
    );
    await this.record(
      'sandbox.visitor.fold',
      visitorUserId,
      target,
      via,
      result,
    );
    if (result.done) await this.cleanUp(visitorUserId, idpUserId);
    return result;
  }

  /** After the merge is committed: nothing here can undo it, so a failure is only logged. */
  private async cleanUp(
    visitorUserId: string,
    idpUserId: string | null,
  ): Promise<void> {
    await this.projects
      .removePersonal(visitorUserId)
      .catch((error: unknown) =>
        this.logger.warn(
          `Merged visitor ${visitorUserId}: personal project left behind: ${describeError(error)}`,
        ),
      );
    if (!idpUserId) return;
    await this.directory.deleteUser(idpUserId).catch((error: unknown) => {
      if (error instanceof NotFoundException) return;
      this.logger.warn(
        `Merged visitor ${visitorUserId}: its identity-provider account ${idpUserId} was not removed: ${describeError(error)}`,
      );
    });
  }

  private record(
    action: string,
    visitorUserId: string,
    target: Pick<UserEntity, 'id' | 'email'> | null,
    via: VisitorMergeVia,
    result: MergeResult,
  ): Promise<void> {
    return this.audit.record({
      userId: visitorUserId,
      email: null,
      actorKind: 'user',
      action,
      target: {
        visitorUserId,
        via,
        ...(target ? { intoUserId: target.id } : {}),
        ...(result.reason ? { reason: result.reason } : {}),
      },
      outcome: result.done ? 'ok' : 'refused',
    });
  }
}
