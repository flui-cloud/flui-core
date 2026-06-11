import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { REQUIRED_SCOPES_KEY } from '../decorators/scope.decorator';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

/**
 * Issuer-agnostic scope gate: reads granted scopes off the authenticated
 * principal (populated by whichever strategy ran — API key column or token
 * claim) and enforces the route's required scopes. Mirrors AdminGuard's shape.
 */
@Injectable()
export class ScopeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(
      REQUIRED_SCOPES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required?.length) return true;

    const user = context
      .switchToHttp()
      .getRequest<{ user?: AuthenticatedUser }>().user;
    const granted = new Set(user?.scopes ?? []);
    const missing = required.filter((s) => !granted.has(s));
    if (missing.length) {
      throw new ForbiddenException(
        `Missing required scope(s): ${missing.join(', ')}`,
      );
    }
    return true;
  }
}
