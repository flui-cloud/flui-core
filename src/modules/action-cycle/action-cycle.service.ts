import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { ActionProposalEntity } from './entities/action-proposal.entity';
import { AgentConcessionEntity } from './entities/agent-concession.entity';
import {
  ACTION_PROPOSAL_CODE,
  ACTION_PROPOSAL_DENIED_CODE,
  ActionBinding,
  PROPOSAL_DECISION,
  PROPOSAL_DECISION_PATH,
  PROPOSAL_STATUS,
  PROPOSAL_TTL_MS,
  ProposalDecision,
  ProposalStatus,
  argsDigest,
  bindingOf,
  composeSentence,
  concessionCovers,
  isProposalLive,
  renderRoute,
} from './action-cycle.core';
import { ActionCycleDecl } from './action-cycle.decorator';
import {
  InfrastructureOperationEntity,
  OperationStatus,
} from '../infrastructure/servers/entities/infrastructure-operations.entity';

/** What the guard hands over: everything about one attempt, and nothing about Nest. */
export interface ActionAttempt {
  decl: ActionCycleDecl;
  ownerUserId: string;
  keyId?: string;
  method: string;
  /** Concrete path, API prefix already stripped. */
  path: string;
  params?: Record<string, unknown>;
  body?: unknown;
}

function decidedStatus(decision: ProposalDecision): ProposalStatus {
  if (decision === PROPOSAL_DECISION.DENY) return PROPOSAL_STATUS.DENIED;
  if (decision === PROPOSAL_DECISION.ALWAYS) return PROPOSAL_STATUS.CONSUMED;
  return PROPOSAL_STATUS.APPROVED;
}

/** How an attempt was allowed to proceed, for attribution on whatever it starts. */
export interface ActionVerdict {
  /** The standing concession that removed the pause, when one did. */
  grantId?: string;
  /** The one-time approval that was spent, when one was. */
  proposalId?: string;
}

/**
 * The cycle itself: propose, price, approve, execute, attribute, stop.
 *
 * It lives beside the operations domain rather than inside a panel, because a
 * control that only the panel performs is a control the same credential skips
 * by calling the API directly — and the credential, not the client, is what
 * decides whether an actor is an agent.
 */
@Injectable()
export class ActionCycleService {
  private readonly logger = new Logger(ActionCycleService.name);

  constructor(
    @InjectRepository(ActionProposalEntity)
    private readonly proposals: Repository<ActionProposalEntity>,
    @InjectRepository(AgentConcessionEntity)
    private readonly concessions: Repository<AgentConcessionEntity>,
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operations: Repository<InfrastructureOperationEntity>,
    private readonly config: ConfigService,
  ) {}

  /**
   * The four questions the guard asks, in the order that makes the cheapest
   * answer the first one.
   *
   * Throws the typed refusal itself rather than returning it, so a caller that
   * forgets to check a boolean fails closed instead of proceeding.
   */
  async authorize(attempt: ActionAttempt): Promise<ActionVerdict> {
    const binding = bindingOf(attempt.decl.bind, attempt.params);

    const standing = await this.matchingConcession(attempt, binding);
    if (standing) {
      // Fire-and-forget: "when was this last used" is register material, and a
      // failed bookkeeping write must not refuse a call that was allowed.
      void this.concessions
        .update(standing.id, { lastUsedAt: new Date() })
        .catch((error) =>
          this.logger.warn(
            `Could not stamp concession ${standing.id} as used: ${String(error)}`,
          ),
        );
      return { grantId: standing.id };
    }

    const digest = argsDigest(attempt.decl.action, binding, attempt.body);
    const existing = await this.proposals.findOne({
      where: {
        ownerUserId: attempt.ownerUserId,
        action: attempt.decl.action,
        argsDigest: digest,
      },
      order: { createdAt: 'DESC' },
    });

    if (existing?.status === PROPOSAL_STATUS.APPROVED) {
      // "Allow once" is spent here and only here, so the same approval cannot
      // be replayed by a second call carrying the same arguments.
      const spent = await this.proposals.update(
        { id: existing.id, status: PROPOSAL_STATUS.APPROVED },
        { status: PROPOSAL_STATUS.CONSUMED },
      );
      if (spent.affected) return { proposalId: existing.id };
    }

    if (existing?.status === PROPOSAL_STATUS.DENIED) {
      throw new ForbiddenException({
        statusCode: 403,
        code: ACTION_PROPOSAL_DENIED_CODE,
        message:
          'This exact call was refused by the person you act for, and the answer stands. ' +
          'Do NOT retry it: nothing about the call changes the answer. Say what was refused ' +
          'and ask for a different course of action.',
        proposalId: existing.id,
        action: attempt.decl.action,
      });
    }

    const proposal = await this.raise(attempt, binding, digest, existing);
    throw new ForbiddenException({
      statusCode: 403,
      code: ACTION_PROPOSAL_CODE,
      message:
        `This call needs a person to allow it first. It has been raised as a request: ${proposal.sentence}. ` +
        'This is a WAIT, not a failure and not a permission problem — nothing was changed. ' +
        'Do not vary the arguments to get around it; retry the identical call once the ' +
        'person has answered, and it will go through.',
      proposalId: proposal.id,
      action: proposal.action,
      sentence: proposal.sentence,
      offersAlways: proposal.offersAlways,
      estimateRef: proposal.estimateRef ?? undefined,
      consequence: proposal.consequence ?? undefined,
      // Where a person answers. Stated by the API rather than assembled by each
      // surface: the MCP server turns this refusal into a URL elicitation, and a
      // second copy of "which page decides a request" would be a second thing
      // to keep in step with the interface.
      decideUrl: this.decideUrl(proposal.id),
      expiresAt: proposal.expiresAt?.toISOString(),
    });
  }

  private decideUrl(proposalId: string): string {
    const configured =
      this.config.get<string>('FRONTEND_URL') ??
      this.config.get<string>('DASHBOARD_URL') ??
      'http://localhost:4200';
    let base = configured;
    while (base.endsWith('/')) base = base.slice(0, -1);
    return `${base}${PROPOSAL_DECISION_PATH}/${proposalId}`;
  }

  private async matchingConcession(
    attempt: ActionAttempt,
    binding: ActionBinding | undefined,
  ): Promise<AgentConcessionEntity | null> {
    if (!attempt.keyId) return null;
    const candidates = await this.concessions.find({
      where: {
        ownerUserId: attempt.ownerUserId,
        keyId: attempt.keyId,
        action: attempt.decl.action,
        revokedAt: IsNull(),
      },
    });
    return (
      candidates.find((c) =>
        concessionCovers(c, {
          method: attempt.method,
          path: attempt.path,
          binding,
          keyId: attempt.keyId,
        }),
      ) ?? null
    );
  }

  /**
   * Upsert on the digest, so an agent that retries three times asks once.
   *
   * An expired question is refreshed in place rather than duplicated: the id
   * the agent already reported to its user stays the id of the thing the person
   * is looking at.
   */
  private async raise(
    attempt: ActionAttempt,
    binding: ActionBinding | undefined,
    digest: string,
    existing: ActionProposalEntity | null,
  ): Promise<ActionProposalEntity> {
    const expiresAt = new Date(Date.now() + PROPOSAL_TTL_MS);
    if (existing?.status === PROPOSAL_STATUS.PENDING) {
      if (isProposalLive(existing)) return existing;
      existing.expiresAt = expiresAt;
      return this.proposals.save(existing);
    }

    // Composed here and stored, so what a person reads is what was written
    // down: the clause is the only part of the sentence that depends on the
    // body, and the body is hashed and dropped a line above.
    const sentence = composeSentence(
      attempt.decl.sentence,
      binding,
      attempt.decl.clause,
      attempt.body,
    );
    return this.proposals.save(
      this.proposals.create({
        ownerUserId: attempt.ownerUserId,
        keyId: attempt.keyId ?? null,
        action: attempt.decl.action,
        routePath: attempt.path,
        binding: binding ?? null,
        argsDigest: digest,
        sentence,
        // The mockup's rule, mechanically: a request that cannot state its own
        // edge is not allowed to offer a standing permission. Both halves have
        // to hold — a declared edge, and a credential to attach it to.
        offersAlways: !!binding && !!attempt.keyId,
        estimateRef: attempt.decl.estimate
          ? (renderRoute(attempt.decl.estimate, attempt.params) ?? null)
          : null,
        consequence: attempt.decl.consequence ?? null,
        status: PROPOSAL_STATUS.PENDING,
        expiresAt,
      }),
    );
  }

  // ── What a person sees and answers ──────────────────────────────────

  listProposals(
    ownerUserId: string,
    status?: string,
  ): Promise<ActionProposalEntity[]> {
    return this.proposals.find({
      where: status
        ? { ownerUserId, status: status as never }
        : { ownerUserId },
      order: { createdAt: 'DESC' },
      take: 200,
    });
  }

  /** Owner-only on purpose: a proposal is a question addressed to somebody. */
  async ownProposal(
    id: string,
    ownerUserId: string,
  ): Promise<ActionProposalEntity> {
    const proposal = await this.proposals.findOne({ where: { id } });
    if (proposal?.ownerUserId !== ownerUserId) {
      // The same 404 a missing id gets: somebody else's request must not be
      // distinguishable from one that does not exist.
      throw new NotFoundException(`Request ${id} not found`);
    }
    return proposal;
  }

  async decideProposal(
    id: string,
    ownerUserId: string,
    decision: ProposalDecision,
  ): Promise<{
    proposal: ActionProposalEntity;
    concession?: AgentConcessionEntity;
  }> {
    const proposal = await this.ownProposal(id, ownerUserId);
    if (proposal.status !== PROPOSAL_STATUS.PENDING) {
      throw new ForbiddenException(
        `This request was already answered (${proposal.status}).`,
      );
    }
    if (!isProposalLive(proposal)) {
      throw new ForbiddenException(
        'This request — and the estimate on it — has expired. The agent will raise a fresh one on its next attempt.',
      );
    }
    if (decision === PROPOSAL_DECISION.ALWAYS && !proposal.offersAlways) {
      throw new ForbiddenException(
        'This request could not state its own boundary, so it can only be allowed once.',
      );
    }

    let concession: AgentConcessionEntity | undefined;
    if (decision === PROPOSAL_DECISION.ALWAYS) {
      concession = await this.concessions.save(
        this.concessions.create({
          keyId: proposal.keyId ?? null,
          ownerUserId,
          action: proposal.action,
          binding: proposal.binding ?? null,
          // Verbatim: the register has to show the sentence that was read, not
          // one re-rendered later from a template that may since have changed.
          sentence: proposal.sentence,
          fromProposalId: proposal.id,
        }),
      );
    }

    // "Always" spends the question outright rather than leaving a one-shot
    // approval beside the concession. Found by falsifying the revoke: with an
    // `APPROVED` row still lying there, taking the concession back let exactly
    // one more call through — the guard would have found the stale approval and
    // spent it. A standing permission is the only thing that carries this shape
    // forward, so nothing else may.
    proposal.status = decidedStatus(decision);
    proposal.decidedAt = new Date();
    proposal.decidedByUserId = ownerUserId;
    proposal.concessionId = concession?.id ?? null;
    const saved = await this.proposals.save(proposal);
    return { proposal: saved, concession };
  }

  // ── Standing permissions, and taking them back ──────────────────────

  listConcessions(ownerUserId: string): Promise<AgentConcessionEntity[]> {
    return this.concessions.find({
      where: { ownerUserId },
      order: { createdAt: 'DESC' },
      take: 200,
    });
  }

  async ownConcession(
    id: string,
    ownerUserId: string,
  ): Promise<AgentConcessionEntity> {
    const concession = await this.concessions.findOne({ where: { id } });
    if (concession?.ownerUserId !== ownerUserId) {
      throw new NotFoundException(`Concession ${id} not found`);
    }
    return concession;
  }

  /**
   * What is still moving under this concession.
   *
   * The revoke dialog is required to say it. A person deciding to take a
   * permission back is entitled to know that three provisionings started under
   * it are still running, because the honest answer to "does this stop them" is
   * "no, not by itself" — and a dialog that hides the question makes the
   * revoke feel like something it is not.
   */
  runningUnder(concessionId: string): Promise<InfrastructureOperationEntity[]> {
    return this.operations.find({
      where: [
        { grantId: concessionId, status: OperationStatus.PENDING },
        { grantId: concessionId, status: OperationStatus.IN_PROGRESS },
      ],
      order: { createdAt: 'DESC' },
      take: 100,
    });
  }

  /**
   * Revoke, and — only if asked — request that what is already running stops.
   *
   * The two halves are deliberately separate verbs joined by one gesture. The
   * revoke is instant and total: the guard reads this table on every request,
   * so nothing else departs under this permission from the moment the row is
   * written. The stop is a *request*, honoured at the next step boundary,
   * because a ten-step provisioning aborted mid-step leaves paid-for debris
   * behind — which is a worse outcome than the one the person was trying to
   * avoid.
   */
  async revoke(
    id: string,
    ownerUserId: string,
    alsoStop = false,
  ): Promise<{
    concession: AgentConcessionEntity;
    stopRequested: string[];
    stillRunning: string[];
  }> {
    const concession = await this.ownConcession(id, ownerUserId);
    if (!concession.revokedAt) {
      concession.revokedAt = new Date();
      concession.revokedByUserId = ownerUserId;
      await this.concessions.save(concession);
    }

    const running = await this.runningUnder(id);
    if (!alsoStop) {
      return {
        concession,
        stopRequested: [],
        stillRunning: running.map((o) => o.id),
      };
    }

    const stopRequested: string[] = [];
    for (const operation of running) {
      await this.operations.update(
        { id: operation.id, cancelRequestedAt: IsNull() },
        { cancelRequestedAt: new Date() },
      );
      stopRequested.push(operation.id);
    }
    return { concession, stopRequested, stillRunning: [] };
  }

  /** Every concession this credential still holds — the panel's "what it may do without asking". */
  activeForKey(
    ownerUserId: string,
    keyId: string,
  ): Promise<AgentConcessionEntity[]> {
    return this.concessions.find({
      where: { ownerUserId, keyId, revokedAt: IsNull() },
    });
  }

  /** Concessions that have been taken back, for the register. */
  revokedFor(ownerUserId: string): Promise<AgentConcessionEntity[]> {
    return this.concessions.find({
      where: { ownerUserId, revokedAt: Not(IsNull()) },
      order: { revokedAt: 'DESC' },
      take: 200,
    });
  }
}
