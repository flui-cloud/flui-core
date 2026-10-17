import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { IamRoleBindingEntity } from '../../iam/entities/iam-role-binding.entity';
import { IAM_ROLE } from '../../iam/constants/iam-roles';
import { SHOWCASE_GRANT } from '../../iam/constants/iam-showcase';
import { SANDBOX_CONFIG, SandboxConfig } from '../sandbox.config';
import { USER_KIND, UserKind } from '../../auth/entities/user.entity';
import { SandboxVisitorEntity } from '../entities/sandbox-visitor.entity';
import {
  SandboxVisitorLoginClientEntity,
  VISITOR_LOGIN_CLIENT_ROW,
} from '../entities/sandbox-visitor-login-client.entity';
import { isTryClient } from '../visitors/visitor.config';
import { accessGrantsChanged } from '../../iam/services/access-grants-changed';

export const SANDBOX_GUEST_ENROLMENT = 'SANDBOX_GUEST_ENROLMENT';

export type RetiredVisitor = 'merged' | 'removed';

export interface NewPerson {
  userId: string;
  /** Only a verified address; a placeholder is passed as null. */
  email: string | null;
  /** The identity provider already gave this person a role on Flui. */
  hasProviderRoles: boolean;
  /** A visitor is given its own roles where it is made, never a guest's. */
  kind?: UserKind;
}

export interface SandboxGuestEnrolment {
  /** `manager`: enrol inside the caller's transaction. */
  enrol(person: NewPerson, manager?: EntityManager): Promise<boolean>;
  /**
   * Asked once no person has this identity: any visitor row for it means Flui
   * made it, so it was merged into another account or is gone, and it never
   * comes back as a new person, even with a token issued before. Says which,
   * or null for anybody else.
   */
  isRetiredVisitor?(idpUserId: string): Promise<RetiredVisitor | null>;
  /**
   * Whether a token was issued to one of the two "try" applications, also
   * after the visitors' entrance was shut.
   */
  isTryClient?(clientId: string | null): Promise<boolean>;
}

/**
 * On a demo instance, a person signing in for the first time becomes a guest:
 * they see the showcase, and what they create is theirs alone. Somebody the
 * operator already invited (a grant to their address, or a role from the
 * identity provider) is not a guest and is left as they are.
 */
@Injectable()
export class SandboxGuestEnrolmentService implements SandboxGuestEnrolment {
  private readonly logger = new Logger(SandboxGuestEnrolmentService.name);

  constructor(
    @InjectRepository(IamRoleBindingEntity)
    private readonly bindings: Repository<IamRoleBindingEntity>,
    @Inject(SANDBOX_CONFIG) private readonly config: SandboxConfig,
    @InjectRepository(SandboxVisitorEntity)
    private readonly visitors: Repository<SandboxVisitorEntity>,
    @InjectRepository(SandboxVisitorLoginClientEntity)
    private readonly loginClients: Repository<SandboxVisitorLoginClientEntity>,
  ) {}

  async enrol(person: NewPerson, manager?: EntityManager): Promise<boolean> {
    if (!this.config.enabled || person.hasProviderRoles) return false;
    if (person.kind === USER_KIND.VISITOR) return false;
    const bindings =
      manager?.getRepository(IamRoleBindingEntity) ?? this.bindings;

    const invited = person.email
      ? await bindings.exists({
          where: { principalType: 'user', principalRef: person.email },
        })
      : false;
    if (invited) return false;

    const already = await bindings.exists({
      where: { principalType: 'user', principalRef: person.userId },
    });
    if (already) return false;

    await bindings.save([
      bindings.create({
        principalType: 'user',
        principalRef: person.userId,
        role: IAM_ROLE.SANDBOX,
        scopeType: 'selector',
        scopeRef: null,
        selector: { owner: person.userId },
      }),
      bindings.create({
        principalType: 'user',
        principalRef: person.userId,
        role: SHOWCASE_GRANT.role,
        scopeType: 'selector',
        scopeRef: null,
        selector: SHOWCASE_GRANT.selector,
      }),
    ]);
    accessGrantsChanged();
    this.logger.log(`New person ${person.userId} enrolled as a demo guest`);
    return true;
  }

  async isRetiredVisitor(idpUserId: string): Promise<RetiredVisitor | null> {
    const row = await this.visitors.findOne({
      where: { idpUserId },
      order: { createdAt: 'DESC' },
    });
    if (!row) return null;
    return row.linkedUserId ? 'merged' : 'removed';
  }

  async isTryClient(clientId: string | null): Promise<boolean> {
    if (!clientId) return false;
    if (isTryClient(clientId)) return true;
    const row = await this.loginClients.findOne({
      where: { id: VISITOR_LOGIN_CLIENT_ROW },
    });
    return !!row && [row.webClientId, row.cliClientId].includes(clientId);
  }
}
