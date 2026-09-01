import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { ACTION_CYCLE_KEY, ActionCycleDecl } from './action-cycle.decorator';
import { ActionAttempt, ActionCycleService } from './action-cycle.service';
import {
  ACTION_PROPOSAL_CODE,
  ACTION_PROPOSAL_DENIED_CODE,
  stripApiPrefix,
} from './action-cycle.core';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { actorFromRequest } from '../auth/utils/actor.util';
import { setCurrentGrant } from '../auth/utils/actor-context';
import { agentSurfaceOf } from '../auth/utils/actor-surface';
import { RequestWithApiKey } from '../auth/strategies/api-key.strategy';
import { REQUIRED_PERMISSION_KEY } from '../iam/decorators/require-permission.decorator';
import {
  AgentCallEntry,
  AgentCallRegister,
} from '../mcp/audit/agent-call-register';

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
 * **Only agents wait, and an agent is not only a credential.** `actor.kind` is
 * derived from two things a client cannot assert: the credential's `mcp:*`
 * ceiling — which is why the same key presented by `curl` meets exactly this
 * guard and gets exactly the same request id, a control only the MCP server
 * performed being theatre — and the agentic surface the call came through,
 * carried across the loopback hop by this process and signed with a token only
 * it holds.
 *
 * The second half is the assimilation of the two agentic surfaces. The portal's
 * assistant runs the same tools, writes included, on the person's own browser
 * session; the ceiling says nothing about it and it used to walk past. The
 * question that actually separates the two cases is not *what credential is
 * this* but **who wrote the arguments** — and a pause between "the model
 * proposed this" and "the person confirmed it" is not theatre even when the
 * same human being is on both ends, because what is confirmed is not what they
 * wrote. A person filling in a form or typing a `flui` command is untouched,
 * and that is the case this must never reach: there, they are the approver, not
 * the applicant.
 *
 * **It is also where the register learns about a call nobody else sees.**
 * `mcp_tool_call_logs` was written by the MCP server and by the assistant, so an
 * agent presenting its key to `curl` — the case this guard exists to catch —
 * did everything it did without leaving a row. The cycle stopped it either way,
 * so nothing was open; but the panel promises *what your agent did* and said
 * nothing at all about those calls. The register is the **credential's**, and
 * this is the door a credential comes through when no surface ran in front of
 * it. When one did, the row is that surface's to write and this writes nothing:
 * the loopback hop declares itself, so the two can never both claim one call.
 */
@Injectable()
export class ActionCycleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly cycle: ActionCycleService,
    private readonly register: AgentCallRegister,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const attempt = this.attemptOf(context);
    if (!attempt) return true;
    const entry = this.entryOf(context, attempt);

    try {
      const verdict = await this.cycle.authorize(attempt);

      // Attribution rides the context the previous round opened, rather than a
      // second mechanism beside it: the operation row this call is about to
      // create stamps itself from here, in the same insert hook that already
      // stamps who acted. Without the join, "what is still running under the
      // permission I am about to revoke" has no answer.
      const grantId = verdict.grantId ?? verdict.proposalId;
      setCurrentGrant(grantId);
      if (entry) await this.register.departed(entry, grantId ?? null);
      // Refusal is a throw out of `authorize`, never a `false` from here.
      return true;
    } catch (error) {
      if (entry) await this.recordRefusal(entry, error);
      throw error;
    }
  }

  /**
   * The two refusals the cycle raises, and nothing else.
   *
   * A read of `action_proposals` that failed is not something an agent did, and
   * writing it here would put an outage in the row a person reviews an agent
   * by. Classified on the `code` the cycle put in the body — never on the
   * prose beside it, which is written for a model and gets reworded.
   */
  private async recordRefusal(
    entry: AgentCallEntry,
    error: unknown,
  ): Promise<void> {
    const body = refusalBody(error);
    const proposalId =
      typeof body?.proposalId === 'string' ? body.proposalId : null;
    if (body?.code === ACTION_PROPOSAL_CODE && proposalId) {
      await this.register.waiting(entry, proposalId, ACTION_PROPOSAL_CODE);
      return;
    }
    if (body?.code === ACTION_PROPOSAL_DENIED_CODE) {
      await this.register.refused(
        entry,
        proposalId,
        ACTION_PROPOSAL_DENIED_CODE,
      );
    }
  }

  /**
   * What the register is told about this call, or `null` when the row is
   * somebody else's to write.
   *
   * A tool reaches the product over a loopback hop that declares its surface,
   * and that surface already writes a row of its own — with the tool's name on
   * it, which is the more useful of the two. A second row from here would
   * double every MCP call in the panel and in the per-credential counts.
   */
  private entryOf(
    context: ExecutionContext,
    attempt: ActionAttempt,
  ): AgentCallEntry | null {
    const req = requestOf(context);
    if (agentSurfaceOf(req.headers as Record<string, unknown>)) return null;
    const permission = this.reflector.getAllAndOverride<string>(
      REQUIRED_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    return {
      userId: attempt.ownerUserId,
      // Rebuilt from the attempt rather than derived a second time: reaching
      // this line at all means `attemptOf` already classified the caller as an
      // agent, and a second derivation is a second chance to disagree.
      actor: { kind: 'agent', keyId: attempt.keyId },
      action: attempt.decl.action,
      permission: typeof permission === 'string' ? permission : null,
    };
  }

  /** The attempt this call is, or `null` when nothing about it waits. */
  private attemptOf(context: ExecutionContext): ActionAttempt | null {
    if (context.getType() !== 'http') return null;

    const decl = this.reflector.getAllAndOverride<ActionCycleDecl>(
      ACTION_CYCLE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!decl) return null;

    const req = requestOf(context);
    const user = req.user;
    if (!user) return null;

    const actor = actorFromRequest(req);
    if (actor.kind !== 'agent') return null;

    // A route with a dry-run mode is two actions on one path and only one of
    // them writes. The other must not raise a question, because the question
    // would describe the deploy this call is not doing — and that sentence is
    // stored verbatim and copied onto whatever is conceded.
    if (isDryRun(decl, req.body)) return null;

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

type GuardedRequest = Request & {
  user?: AuthenticatedUser;
} & RequestWithApiKey;

function requestOf(context: ExecutionContext): GuardedRequest {
  return context.switchToHttp().getRequest<GuardedRequest>();
}

/**
 * Does this call's own body say it acts on nothing?
 *
 * Fail-closed towards pausing: guards run before pipes, so the body is whatever
 * was posted, and a predicate that cannot read it — or throws on it — leaves the
 * call inside the cycle.
 */
function isDryRun(decl: ActionCycleDecl, body: unknown): boolean {
  if (!decl.dryRun) return false;
  try {
    return decl.dryRun(body) === true;
  } catch {
    return false;
  }
}

/** The body a Nest exception carries, when it carries an object at all. */
function refusalBody(error: unknown): Record<string, unknown> | null {
  if (!(error instanceof ForbiddenException)) return null;
  const body = error.getResponse();
  return body && typeof body === 'object'
    ? (body as Record<string, unknown>)
    : null;
}
