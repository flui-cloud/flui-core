import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IamRoleBindingEntity } from '../../iam/entities/iam-role-binding.entity';
import { IAM_ROLE } from '../../iam/constants/iam-roles';
import { SHOWCASE_GRANT } from '../../iam/constants/iam-showcase';
import { SANDBOX_CONFIG, SandboxConfig } from '../sandbox.config';

export const SANDBOX_GUEST_ENROLMENT = 'SANDBOX_GUEST_ENROLMENT';

export interface NewPerson {
  userId: string;
  /** Only a verified address; a placeholder is passed as null. */
  email: string | null;
  /** The identity provider already gave this person a role on Flui. */
  hasProviderRoles: boolean;
}

export interface SandboxGuestEnrolment {
  enrol(person: NewPerson): Promise<boolean>;
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
  ) {}

  async enrol(person: NewPerson): Promise<boolean> {
    if (!this.config.enabled || person.hasProviderRoles) return false;

    const invited = person.email
      ? await this.bindings.exists({
          where: { principalType: 'user', principalRef: person.email },
        })
      : false;
    if (invited) return false;

    const already = await this.bindings.exists({
      where: { principalType: 'user', principalRef: person.userId },
    });
    if (already) return false;

    await this.bindings.save([
      this.bindings.create({
        principalType: 'user',
        principalRef: person.userId,
        role: IAM_ROLE.SANDBOX,
        scopeType: 'selector',
        scopeRef: null,
        selector: { owner: person.userId },
      }),
      this.bindings.create({
        principalType: 'user',
        principalRef: person.userId,
        role: SHOWCASE_GRANT.role,
        scopeType: 'selector',
        scopeRef: null,
        selector: SHOWCASE_GRANT.selector,
      }),
    ]);
    this.logger.log(`New person ${person.userId} enrolled as a demo guest`);
    return true;
  }
}
