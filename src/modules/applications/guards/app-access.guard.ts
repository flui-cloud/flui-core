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
import {
  applicationCeilingRefusal,
  applicationCeilingWithholds,
  ceilingRefusal,
  credentialCeiling,
} from '../../auth/utils/credential-ceiling.util';

export const APP_ACTION_KEY = 'app_action';

/** Override the permission AppAccessGuard requires for a route (default: derived from the HTTP method). */
export const AppAction = (action: string) =>
  SetMetadata(APP_ACTION_KEY, action);

/**
 * Resource-aware gate for single-application routes (those naming the application
 * in `:applicationId`, `:appId` or `:id`).
 * Loads the target app, builds its ResourceAttributes and asks the PolicyEngine
 * whether the caller may act on it. Default action is derived from the HTTP method
 * (GET → app:read, otherwise app:write); override with @AppAction for finer verbs.
 * Routes without an `:id` (list/create) are enforced by their handler (list
 * filtering) instead.
 *
 * Two questions, not one — and the second is why `isAdmin` no longer passes
 * first. The IAM check asks what the *person* may do with this application. The
 * credential ceiling asks what the *key in their hand* may do, and an `mcp:*`
 * scoped key is least-privilege even when the person behind it is an
 * administrator. This is the guard that governs the application surface, so
 * putting the ceiling only in `PermissionsGuard` left it out of everywhere it
 * mattered: `@RequirePermission` names no `app:*` permission anywhere in the
 * product.
 *
 * A credential declaring no `mcp:*` scope — every interactive session, the CLI
 * key, the service identities, the sandbox session cookie — sees no change.
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

    // Three spellings appear across the API for the same thing. Reading only
    // `id` made this guard a no-op wherever a route said `:appId` — it would
    // find nothing, conclude the route was not app-scoped, and allow the call.
    // A guard that silently passes is worse than an absent one, because adding
    // it looks like the problem is solved.
    //
    // The order is not cosmetic. `:applicationId` and `:appId` are read first
    // because a route that uses one of them may nest a sub-resource under
    // `:id`, which would then name the sub-resource and not the application —
    // reading `id` first there loads the wrong row and 404s a route the caller
    // is entitled to. Round E2 removed the case that proved it
    // (`crash-diagnoses` now says `:id` for the application and `:diagnosisId`
    // for the diagnosis), but `:applicationId` still names the application on
    // the build routes, so the precedence stays.
    const id = req.params?.applicationId ?? req.params?.appId ?? req.params?.id;
    if (!id) return true; // not a single-app route — handler enforces

    const action =
      this.reflector.getAllAndOverride<string>(APP_ACTION_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ??
      (req.method === 'GET'
        ? IAM_PERMISSION.APP_READ
        : IAM_PERMISSION.APP_WRITE);

    // Asked before the application is loaded, deliberately: whether the
    // credential carries this verb at all does not depend on which application
    // was named, and answering it first means a scoped key gets a 403 that
    // names its own scopes instead of a 404 that leaks whether the row exists.
    const ceiling = credentialCeiling(user);
    if (ceiling && !ceiling.has(action)) {
      throw new ForbiddenException(ceilingRefusal(action, user));
    }

    // Asked before `isAdmin`, for the same reason a scoped key is
    // least-privilege even for an administrator above: a key limited to
    // specific applications must stay limited to them regardless of who
    // minted it, or the account most likely to hand out these keys — an
    // administrator, on their own apps — would be the one case the ceiling
    // never actually held.
    if (applicationCeilingWithholds(user, id)) {
      throw new ForbiddenException(applicationCeilingRefusal(id));
    }

    if (user.isAdmin) return true;

    const app = await this.apps.findById(id); // 404 if missing
    await this.access.assertCan(user, action, app);
    return true;
  }
}
