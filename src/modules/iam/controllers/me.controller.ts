import { Controller, Get, Inject, Req } from '@nestjs/common';
import { Request } from 'express';
import {
  POLICY_ENGINE,
  PolicyEngine,
} from '../interfaces/policy-engine.interface';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { IamPrincipal } from '../interfaces/iam.types';

@Controller('me')
export class MeController {
  constructor(@Inject(POLICY_ENGINE) private readonly policy: PolicyEngine) {}

  /** Effective permission set for the current user. Drives dashboard show/hide. */
  @Get('permissions')
  async permissions(
    @Req() req: Request,
  ): Promise<{ permissions: string[]; isAdmin: boolean }> {
    const user = req.user as AuthenticatedUser;
    const principal: IamPrincipal = {
      userId: user.userId,
      email: user.email,
      role: user.role,
      isAdmin: !!user.isAdmin,
      scopes: user.scopes,
    };
    return {
      permissions: await this.policy.getEffectivePermissions(principal),
      isAdmin: !!user.isAdmin,
    };
  }

  /**
   * Portal sections the current user may enter. Drives the dashboard sidebar.
   *
   * `readOnlySections` is a subset of `sections`, not a separate list: a section
   * named there is open, and every control inside it is drawn disabled. Older
   * callers that read only `sections` therefore keep working — they show the
   * section, and the API refuses the writes they would otherwise offer.
   */
  @Get('sections')
  async sections(@Req() req: Request): Promise<{
    sections: string[];
    readOnlySections: string[];
    isAdmin: boolean;
  }> {
    const user = req.user as AuthenticatedUser;
    const principal: IamPrincipal = {
      userId: user.userId,
      email: user.email,
      role: user.role,
      isAdmin: !!user.isAdmin,
      scopes: user.scopes,
    };
    const access = await this.policy.resolveSectionAccess(principal);
    return {
      sections: access.map((s) => s.key),
      readOnlySections: access
        .filter((s) => s.level === 'read-only')
        .map((s) => s.key),
      isAdmin: !!user.isAdmin,
    };
  }
}
