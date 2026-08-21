import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable, from, of, switchMap } from 'rxjs';
import {
  SANDBOX_GUEST_REQUEST,
  SandboxGuestRequest,
} from '../guards/sandbox-fence.guard';
import {
  SandboxRouteParams,
  findSandboxProjection,
} from '../constants/sandbox-projection';
import { sandboxLevelOf } from '../constants/sandbox-fence';
import { findSandboxStandIn } from '../stand-in/sandbox-stand-in';
import { SandboxScopeService } from '../services/sandbox-scope.service';

/**
 * How much of this area the caller is being served. Present on every answer a
 * guest gets, so nothing has to infer the level from the shape of the body — the
 * interface turns it into a standing caption, and a script reading the API is
 * told the same thing.
 */
export const SANDBOX_LEVEL_HEADER = 'X-Flui-Sandbox-Level';

/**
 * Applies {@link SANDBOX_PROJECTIONS} to the response of a guest's request.
 *
 * Costs nothing to anyone else: a request the fence did not mark as a guest's,
 * or one on a route with no projection, is returned untouched without a single
 * extra read.
 */
@Injectable()
export class SandboxProjectionInterceptor implements NestInterceptor {
  constructor(private readonly scopes: SandboxScopeService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const req = context
      .switchToHttp()
      .getRequest<Request & SandboxGuestRequest>();
    const guest = req[SANDBOX_GUEST_REQUEST];
    if (!guest) return next.handle();

    const pattern = (req.route as { path?: string } | undefined)?.path;
    const path = stripPrefix(pattern ?? req.path);

    context
      .switchToHttp()
      .getResponse<Response>()
      .setHeader(SANDBOX_LEVEL_HEADER, sandboxLevelOf(req.method, path));

    // Served instead of the handler, never alongside it: the real one would
    // reach the instance's own provider, which is exactly what this replaces.
    const standIn = findSandboxStandIn(req.method, path);
    if (standIn) {
      return of(
        standIn.build(
          Date.now(),
          req.query ?? {},
          req.params as Record<string, string | undefined>,
        ),
      );
    }

    const rule = findSandboxProjection(req.method, path);
    if (!rule) return next.handle();

    return next
      .handle()
      .pipe(
        switchMap((body) =>
          from(
            this.scopes
              .resolve(guest.userId, rule.needs)
              .then((scope) =>
                rule.project(body, scope, req.params as SandboxRouteParams),
              ),
          ),
        ),
      );
  }
}

/** Routes are declared without the global API prefix. */
function stripPrefix(path: string): string {
  return path.replace(/^\/api\/v\d+/, '');
}
