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

  /** Portal sections the current user may enter. Drives the dashboard sidebar. */
  @Get('sections')
  async sections(
    @Req() req: Request,
  ): Promise<{ sections: string[]; isAdmin: boolean }> {
    const user = req.user as AuthenticatedUser;
    const principal: IamPrincipal = {
      userId: user.userId,
      email: user.email,
      role: user.role,
      isAdmin: !!user.isAdmin,
      scopes: user.scopes,
    };
    return {
      sections: await this.policy.resolveSections(principal),
      isAdmin: !!user.isAdmin,
    };
  }
}
