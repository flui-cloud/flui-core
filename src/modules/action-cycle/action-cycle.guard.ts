import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { ACTION_CYCLE_KEY, ActionCycleDecl } from './action-cycle.decorator';
import { ActionAttempt, ActionCycleService } from './action-cycle.service';
import { stripApiPrefix } from './action-cycle.core';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { actorFromRequest } from '../auth/utils/actor.util';
import { setCurrentGrant } from '../auth/utils/actor-context';
import { RequestWithApiKey } from '../auth/strategies/api-key.strategy';

/**
 * Where the action cycle is enforced: the shared door, fifth in the global
 * chain.
 *
 * **After the fence, the permission gate and the section gate, and that order
 * is the whole answer to the guest.** A concession can therefore never widen a
 * boundary — by the time this guard runs, the fence has already decided the
 * route is one this tenancy may call at all, and IAM has already decided the
 * person may. All that is left to remove is the *pause*. A permission is not
 * negotiable; a pause is.
 *
 * **Only agents wait.** `actor.kind` is derived from the credential's `mcp:*`
 * ceiling and from nothing a client asserts, which is why the same key
 * presented by `curl` meets exactly this guard and gets exactly the same
 * request id — a control only the MCP server performed would be theatre. A
 * person's own session never waits, and that is right: the person is the
 * approver, not the applicant.
 */
@Injectable()
export class ActionCycleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly cycle: ActionCycleService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const attempt = this.attemptOf(context);
    if (attempt) {
      const verdict = await this.cycle.authorize(attempt);

      // Attribution rides the context the previous round opened, rather than a
      // second mechanism beside it: the operation row this call is about to
      // create stamps itself from here, in the same insert hook that already
      // stamps who acted. Without the join, "what is still running under the
      // permission I am about to revoke" has no answer.
      setCurrentGrant(verdict.grantId ?? verdict.proposalId);
    }
    // Refusal is a throw out of `authorize`, never a `false` from here.
    return true;
  }

  /** The attempt this call is, or `null` when nothing about it waits. */
  private attemptOf(context: ExecutionContext): ActionAttempt | null {
    if (context.getType() !== 'http') return null;

    const decl = this.reflector.getAllAndOverride<ActionCycleDecl>(
      ACTION_CYCLE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!decl) return null;

    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser } & RequestWithApiKey>();
    const user = req.user;
    if (!user) return null;

    const actor = actorFromRequest(req);
    if (actor.kind !== 'agent') return null;

    return {
      decl,
      ownerUserId: user.userId,
      keyId: actor.keyId,
      method: req.method,
      // The concrete path, so `routeMatches` decides on what was actually
      // called; the pattern is the decoration's, which is what a concession is
      // stored under.
      path: stripApiPrefix(req.path),
      params: req.params as Record<string, unknown>,
      body: req.body,
    };
  }
}
