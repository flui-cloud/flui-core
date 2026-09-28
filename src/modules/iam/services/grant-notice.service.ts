import { Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThanOrEqual, Repository } from 'typeorm';
import { IamRoleBindingEntity } from '../entities/iam-role-binding.entity';
import { UserEntity } from '../../auth/entities/user.entity';
import { BUILTIN_ROLES, IamRole } from '../constants/iam-roles';

const DAY_MS = 86_400_000;

export type GrantNoticeKind = 'granted' | 'expiring' | 'expired';

/**
 * Tells the people who run an installation about access that was lent for a
 * time: when it is lent, the day before it ends, and when it has ended. The
 * administrators and whoever lent it hear all three; the person who received
 * it hears that it is about to end.
 *
 * Never throws. A notice that cannot be delivered must not undo the grant, nor
 * stop the others from going out.
 */
@Injectable()
export class GrantNoticeService {
  private readonly logger = new Logger(GrantNoticeService.name);

  constructor(
    @InjectRepository(IamRoleBindingEntity)
    private readonly bindings: Repository<IamRoleBindingEntity>,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    private readonly config: ConfigService,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  async granted(grant: IamRoleBindingEntity): Promise<void> {
    if (!grant.expiresAt) return;
    await this.announce('granted', grant);
  }

  /** One pass over the temporary grants. */
  async sweep(now = new Date()): Promise<void> {
    const soon = new Date(now.getTime() + DAY_MS);
    const ending = await this.bindings.find({
      where: {
        expiresAt: LessThanOrEqual(soon),
        expiringNoticeAt: IsNull(),
      },
    });
    for (const grant of ending) {
      if (!grant.expiresAt || grant.expiresAt <= now) continue;
      const lent = grant.expiresAt.getTime() - grant.createdAt.getTime();
      if (lent > DAY_MS) await this.announce('expiring', grant);
      await this.bindings.update(grant.id, { expiringNoticeAt: now });
    }

    const ended = await this.bindings.find({
      where: {
        expiresAt: LessThanOrEqual(now),
        expiredNoticeAt: IsNull(),
      },
    });
    for (const grant of ended) {
      await this.announce('expired', grant);
      await this.bindings.update(grant.id, {
        expiredNoticeAt: now,
        expiringNoticeAt: grant.expiringNoticeAt ?? now,
      });
    }
  }

  private async announce(
    kind: GrantNoticeKind,
    grant: IamRoleBindingEntity,
  ): Promise<void> {
    try {
      const role = BUILTIN_ROLES[grant.role as IamRole]?.name ?? grant.role;
      const who = grant.principalRef;
      const until = grant.expiresAt?.toISOString() ?? '';
      const summary = sentenceFor(kind, role, who, until);

      const admins = await this.users.find({
        where: { isAdmin: true },
        select: { id: true, email: true },
      });
      const lender = grant.grantedBy
        ? await this.users.findOne({
            where: { email: grant.grantedBy },
            select: { id: true, email: true },
          })
        : null;
      const watchers = uniqueBy(
        [...admins, ...(lender ? [lender] : [])],
        (u) => u.id,
      );

      await this.ring(kind, grant, summary, watchers);

      const to = new Set(
        watchers.map((u) => u.email).filter((e): e is string => !!e),
      );
      if (kind === 'expiring' && grant.principalType === 'user') {
        to.add(grant.principalRef);
      }
      await this.mail(kind, grant, summary, [...to]);
    } catch (error) {
      this.logger.warn(
        `Access notice (${kind}) for grant ${grant.id} not delivered: ${(error as Error).message}`,
      );
    }
  }

  private async ring(
    kind: GrantNoticeKind,
    grant: IamRoleBindingEntity,
    summary: string,
    to: Array<{ id: string }>,
  ): Promise<void> {
    const { UserEventsGateway } = await import(
      '../../auth/gateway/user-events.gateway'
    );
    const gateway = this.moduleRef?.get(UserEventsGateway, { strict: false });
    if (!gateway) return;
    for (const user of to) {
      gateway.emitAlert(user.id, {
        id: `access-grant:${grant.id}`,
        kind: kind === 'expired' ? 'resolved' : 'fired',
        alertname: 'FluiTemporaryAccess',
        severity: kind === 'granted' ? 'info' : 'warning',
        summary,
        applicationId: null,
        applicationSlug: null,
        startsAt: new Date().toISOString(),
      });
    }
  }

  private async mail(
    kind: GrantNoticeKind,
    grant: IamRoleBindingEntity,
    summary: string,
    to: string[],
  ): Promise<void> {
    const from = this.config.get<string>('MAIL_FROM');
    if (!from || to.length === 0) return;
    const { MailSendService } = await import(
      '../../mail/services/mail-send.service'
    );
    const sender = this.moduleRef?.get(MailSendService, { strict: false });
    if (!sender) return;
    await sender.send({
      from: {
        email: from,
        name: this.config.get<string>('MAIL_FROM_NAME') ?? 'Flui',
      },
      to: to.map((email) => ({ email })),
      subject: subjectFor(kind, grant.principalRef),
      text: [
        summary,
        '',
        'Temporary access is listed, with everything done under it, in Settings → Access.',
      ].join('\n'),
      reference: `access-grant:${grant.id}:${kind}`,
    });
  }
}

export function sentenceFor(
  kind: GrantNoticeKind,
  role: string,
  who: string,
  until: string,
): string {
  switch (kind) {
    case 'granted':
      return `${who} was given ${role} access until ${until}.`;
    case 'expiring':
      return `${who}'s ${role} access ends at ${until}.`;
    case 'expired':
      return `${who}'s ${role} access ended at ${until}.`;
  }
}

function subjectFor(kind: GrantNoticeKind, who: string): string {
  switch (kind) {
    case 'granted':
      return `Temporary access granted to ${who}`;
    case 'expiring':
      return `Temporary access for ${who} ends within a day`;
    case 'expired':
      return `Temporary access for ${who} has ended`;
  }
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const item of items) seen.set(key(item), item);
  return [...seen.values()];
}
