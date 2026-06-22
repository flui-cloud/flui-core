import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { ApplicationService } from '../services/application.service';
import { ApplicationAccessService } from '../services/application-access.service';

export const APP_ACTION_KEY = 'app_action';

/** Override the permission AppAccessGuard requires for a route (default: derived from the HTTP method). */
export const AppAction = (action: string) =>
  SetMetadata(APP_ACTION_KEY, action);

/**
 * Resource-aware gate for single-application routes (those with an `:id` param).
 * Loads the target app, builds its ResourceAttributes and asks the PolicyEngine
 * whether the caller may act on it. Default action is derived from the HTTP method
 * (GET → app:read, otherwise app:write); override with @AppAction for finer verbs.
 * Admins pass through; routes without an `:id` (list/create) are enforced by their
 * handler (list filtering) instead.
 */
@Injectable()
export class AppAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly apps: ApplicationService,
    private readonly access: ApplicationAccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser }>();
    const user = req.user;
    if (!user) throw new ForbiddenException('Unauthenticated');
    if (user.isAdmin) return true;

    const id = req.params?.id;
    if (!id) return true; // not a single-app route — handler enforces

    const action =
      this.reflector.getAllAndOverride<string>(APP_ACTION_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ??
      (req.method === 'GET'
        ? IAM_PERMISSION.APP_READ
        : IAM_PERMISSION.APP_WRITE);

    const app = await this.apps.findById(id); // 404 if missing
    await this.access.assertCan(user, action, app);
    return true;
  }
}
