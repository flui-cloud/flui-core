import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FindOperator } from 'typeorm';
import { ActionCycleGuard } from './action-cycle.guard';
import { ActionCycleService } from './action-cycle.service';
import { ActionCycleController } from './action-cycle.controller';
import { ActionCycleDecl } from './action-cycle.decorator';
import {
  ACTION_PROPOSAL_CODE,
  ACTION_PROPOSAL_DENIED_CODE,
  PROPOSAL_DECISION,
  PROPOSAL_STATUS,
} from './action-cycle.core';
import { ActionProposalEntity } from './entities/action-proposal.entity';
import { AgentConcessionEntity } from './entities/agent-concession.entity';
import { CURRENT_API_KEY_ID } from '../auth/strategies/api-key.strategy';
import {
  AGENT_SURFACE_HEADER,
  ASSISTANT_AGENT_KEY_ID,
  agentSurfaceHeader,
} from '../auth/utils/actor-surface';
import {
  currentGrantId,
  runWithActorContext,
} from '../auth/utils/actor-context';
import { OperationStatus } from '../infrastructure/servers/entities/infrastructure-operations.entity';
import { REQUIRED_PERMISSION_KEY } from '../iam/decorators/require-permission.decorator';
import { AgentCallRegister } from '../mcp/audit/agent-call-register';
import {
  OUTCOME_DEPARTED,
  PERMISSION_UNSTATED,
  REGISTER_SURFACE,
} from '../mcp/audit/register-surface';

/**
 * The cycle, exercised end to end against in-memory rows: an agent asks, a
 * person answers, the agent's own retry executes.
 *
 * The division the suite is built to make is the one the series insists on:
 * the cases that go RED when the guard is taken out are the ones that prove the
 * closure, and the cases that stay GREEN are the ones that prove nothing was
 * taken away from people, from the CLI, or from undecorated routes.
 */

// ── A repository that behaves enough like TypeORM's ──────────────────

function matches(row: Record<string, unknown>, where: Record<string, unknown>) {
  return Object.entries(where).every(([key, expected]) => {
    const actual = row[key];
    if (expected instanceof FindOperator)
      return operatorMatches(expected, actual);
    return actual === expected;
  });
}

function operatorMatches(op: FindOperator<unknown>, actual: unknown): boolean {
  switch (op.type) {
    case 'isNull':
      return actual === null || actual === undefined;
    case 'not':
      return op.value instanceof FindOperator
        ? !operatorMatches(op.value, actual)
        : actual !== op.value;
    default:
      throw new Error(`fake repository does not know operator ${op.type}`);
  }
}

class FakeRepo<T extends { id?: string }> {
  rows: T[] = [];
  private seq = 0;

  create(partial: Partial<T>): T {
    return { ...partial } as T;
  }

  save(entity: T): Promise<T> {
    const row = entity as Record<string, unknown>;
    if (!row.id) {
      row.id = `row-${++this.seq}`;
      row.createdAt = row.createdAt ?? new Date();
      this.rows.push(row as T);
    } else if (!this.rows.includes(row as T)) {
      this.rows.push(row as T);
    }
    return Promise.resolve(row as T);
  }

  find(options?: {
    where?: Record<string, unknown> | Record<string, unknown>[];
  }): Promise<T[]> {
    const where = options?.where;
    if (!where) return Promise.resolve([...this.rows]);
    const clauses = Array.isArray(where) ? where : [where];
    return Promise.resolve(
      this.rows.filter((row) =>
        clauses.some((clause) =>
          matches(row as Record<string, unknown>, clause),
        ),
      ),
    );
  }

  async findOne(options: {
    where: Record<string, unknown>;
  }): Promise<T | null> {
    const found = await this.find(options);
    return found.length ? found[found.length - 1] : null;
  }

  update(
    criteria: string | Record<string, unknown>,
    patch: Partial<T>,
  ): Promise<{ affected: number }> {
    const where = typeof criteria === 'string' ? { id: criteria } : criteria;
    const hits = this.rows.filter((row) =>
      matches(row as Record<string, unknown>, where),
    );
    for (const row of hits) Object.assign(row, patch);
    return Promise.resolve({ affected: hits.length });
  }
}

// ── The cast, assembled once per test ────────────────────────────────

const DEPLOY: ActionCycleDecl = {
  action: 'POST /applications/:id/deploy',
  bind: ['id'],
  sentence: 'deploy application {id} whenever it asks',
};

const NO_EDGE: ActionCycleDecl = {
  action: 'POST /applications/deploy-from-yaml',
  sentence: 'deploy anything described in a manifest',
};

/** The register's own store, so a row can be asked for by hand. */
class FakeAudit {
  rows: Record<string, unknown>[] = [];
  fail = false;

  record(row: Record<string, unknown>): Promise<void> {
    if (this.fail) return Promise.reject(new Error('register is down'));
    this.rows.push(row);
    return Promise.resolve();
  }
}

interface Cast {
  guard: ActionCycleGuard;
  audit: FakeAudit;
  service: ActionCycleService;
  controller: ActionCycleController;
  proposals: FakeRepo<ActionProposalEntity>;
  concessions: FakeRepo<AgentConcessionEntity>;
  operations: FakeRepo<{
    id?: string;
    grantId?: string | null;
    status?: OperationStatus;
    cancelRequestedAt?: Date | null;
  }>;
}

function build(decl: ActionCycleDecl | undefined, permission?: string): Cast {
  const proposals = new FakeRepo<ActionProposalEntity>();
  const concessions = new FakeRepo<AgentConcessionEntity>();
  const operations = new FakeRepo<{
    id?: string;
    grantId?: string | null;
    status?: OperationStatus;
    cancelRequestedAt?: Date | null;
  }>();
  const service = new ActionCycleService(
    proposals as never,
    concessions as never,
    operations as never,
    { get: () => 'https://console.test' } as never,
  );
  const reflector = {
    getAllAndOverride: (key: string) =>
      key === REQUIRED_PERMISSION_KEY ? permission : decl,
  } as unknown as Reflector;
  const audit = new FakeAudit();
  return {
    guard: new ActionCycleGuard(
      reflector,
      service,
      new AgentCallRegister(audit as never),
    ),
    audit,
    service,
    controller: new ActionCycleController(service),
    proposals,
    concessions,
    operations,
  };
}

/** An agent: a credential whose ceiling is declared with `mcp:*` scopes. */
function agentRequest(overrides: Record<string, unknown> = {}) {
  return {
    user: {
      userId: 'owner-1',
      email: 'owner@test',
      role: 'user',
      isAdmin: false,
      scopes: ['mcp:app:write'],
    },
    [CURRENT_API_KEY_ID]: 'key-1',
    method: 'POST',
    path: '/api/v1/applications/app-1/deploy',
    params: { id: 'app-1' },
    body: { branch: 'main' },
    ...overrides,
  };
}

/** A person's browser session: OIDC scopes, no ceiling. */
function personRequest(overrides: Record<string, unknown> = {}) {
  return {
    user: {
      userId: 'owner-1',
      email: 'owner@test',
      role: 'user',
      isAdmin: false,
      scopes: ['openid', 'profile', 'email'],
    },
    method: 'POST',
    path: '/api/v1/applications/app-1/deploy',
    params: { id: 'app-1' },
    body: { branch: 'main' },
    ...overrides,
  };
}

/**
 * The portal's assistant: the same person, the same browser session, and a call
 * whose arguments a model wrote. Nothing about the credential differs from
 * `personRequest` — the surface is the entire difference, and it is declared by
 * this process on the loopback hop, never by a client.
 */
function assistantRequest(overrides: Record<string, unknown> = {}) {
  return personRequest({
    headers: { [AGENT_SURFACE_HEADER]: agentSurfaceHeader('assistant') },
    ...overrides,
  });
}

function contextFor(req: unknown): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

async function refusalOf(promise: Promise<unknown>) {
  try {
    await promise;
    throw new Error('expected the call to be refused');
  } catch (error) {
    if (!(error instanceof ForbiddenException)) throw error;
    return error.getResponse() as Record<string, unknown>;
  }
}

describe('the action cycle', () => {
  describe('who waits, and who does not', () => {
    it("stops an agent's first write and raises the request", async () => {
      const { guard, proposals } = build(DEPLOY);
      const body = await refusalOf(
        guard.canActivate(contextFor(agentRequest())),
      );

      expect(body.code).toBe(ACTION_PROPOSAL_CODE);
      expect(body.sentence).toBe('deploy application app-1 whenever it asks');
      expect(body.offersAlways).toBe(true);
      expect(body.decideUrl).toContain('https://console.test');
      expect(proposals.rows).toHaveLength(1);
      expect(proposals.rows[0].status).toBe(PROPOSAL_STATUS.PENDING);
    });

    it('meets the same guard when the same key is presented by curl', async () => {
      // Nothing about this request came through the MCP server: no round, no
      // elicitation, no client cooperation. The discriminant is the credential,
      // which is the property without which the whole control is theatre.
      const { guard, proposals } = build(DEPLOY);
      const body = await refusalOf(
        guard.canActivate(
          contextFor(
            agentRequest({
              headers: { 'user-agent': 'curl/8.6.0' },
            }),
          ),
        ),
      );
      expect(body.code).toBe(ACTION_PROPOSAL_CODE);
      expect(proposals.rows).toHaveLength(1);
    });

    it('never makes a person wait — they are the approver, not the applicant', async () => {
      const { guard, proposals } = build(DEPLOY);
      await expect(
        guard.canActivate(contextFor(personRequest())),
      ).resolves.toBe(true);
      expect(proposals.rows).toHaveLength(0);
    });

    it('never makes an unscoped key wait — the CLI and service identities', async () => {
      const { guard, proposals } = build(DEPLOY);
      const req = agentRequest();
      (req.user as { scopes: string[] }).scopes = [];
      await expect(guard.canActivate(contextFor(req))).resolves.toBe(true);
      expect(proposals.rows).toHaveLength(0);
    });

    /**
     * `deploy-from-yaml` is two actions on one path: `validateOnly` returns the
     * manifest it would have applied and writes nothing. Pausing it put a
     * person in front of "create or replace an application … and deploy it" for
     * a call that does neither, and stored those words on the concession.
     */
    it('lets a call through that its own body says will not act', async () => {
      const { guard, proposals } = build({
        ...NO_EDGE,
        dryRun: (body) =>
          (body as { validateOnly?: unknown })?.validateOnly === true,
      });
      await expect(
        guard.canActivate(
          contextFor(agentRequest({ body: { validateOnly: true } })),
        ),
      ).resolves.toBe(true);
      expect(proposals.rows).toHaveLength(0);
    });

    it('still asks when the same route is asked to deploy for real', async () => {
      const { guard, proposals } = build({
        ...NO_EDGE,
        dryRun: (body) =>
          (body as { validateOnly?: unknown })?.validateOnly === true,
      });
      await refusalOf(
        guard.canActivate(
          contextFor(agentRequest({ body: { validateOnly: false } })),
        ),
      );
      expect(proposals.rows).toHaveLength(1);
    });

    /** Guards run before pipes, so the predicate meets whatever was posted. */
    it('asks anyway when the dry-run reading throws on the body', async () => {
      const { guard, proposals } = build({
        ...NO_EDGE,
        dryRun: () => {
          throw new Error('unreadable body');
        },
      });
      await refusalOf(guard.canActivate(contextFor(agentRequest())));
      expect(proposals.rows).toHaveLength(1);
    });

    it('leaves every undecorated route exactly as it was', async () => {
      const { guard, proposals } = build(undefined);
      await expect(guard.canActivate(contextFor(agentRequest()))).resolves.toBe(
        true,
      );
      expect(proposals.rows).toHaveLength(0);
    });
  });

  describe('an agent that retries', () => {
    it('asks once, however many times it tries', async () => {
      const { guard, proposals } = build(DEPLOY);
      const first = await refusalOf(
        guard.canActivate(contextFor(agentRequest())),
      );
      const second = await refusalOf(
        guard.canActivate(contextFor(agentRequest())),
      );
      const third = await refusalOf(
        guard.canActivate(contextFor(agentRequest())),
      );

      expect(second.proposalId).toBe(first.proposalId);
      expect(third.proposalId).toBe(first.proposalId);
      expect(proposals.rows).toHaveLength(1);
    });

    it('asks again when it varies the arguments, instead of slipping past', async () => {
      const { guard, proposals } = build(DEPLOY);
      await refusalOf(guard.canActivate(contextFor(agentRequest())));
      await refusalOf(
        guard.canActivate(
          contextFor(agentRequest({ body: { branch: 'other' } })),
        ),
      );
      expect(proposals.rows).toHaveLength(2);
    });
  });

  describe('allow once', () => {
    it("lets the agent's own retry through, and spends the approval", async () => {
      const { guard, service, proposals } = build(DEPLOY);
      const raised = await refusalOf(
        guard.canActivate(contextFor(agentRequest())),
      );
      await service.decideProposal(
        raised.proposalId as string,
        'owner-1',
        PROPOSAL_DECISION.ONCE,
      );

      await expect(guard.canActivate(contextFor(agentRequest()))).resolves.toBe(
        true,
      );
      expect(proposals.rows[0].status).toBe(PROPOSAL_STATUS.CONSUMED);

      // And only once: the second identical call is a new question.
      const again = await refusalOf(
        guard.canActivate(contextFor(agentRequest())),
      );
      expect(again.code).toBe(ACTION_PROPOSAL_CODE);
      expect(again.proposalId).not.toBe(raised.proposalId);
    });

    it('attributes what it starts to the approval that was spent', async () => {
      const { guard, service } = build(DEPLOY);
      const raised = await refusalOf(
        guard.canActivate(contextFor(agentRequest())),
      );
      await service.decideProposal(
        raised.proposalId as string,
        'owner-1',
        PROPOSAL_DECISION.ONCE,
      );

      const seen = await runWithActorContext(async () => {
        await guard.canActivate(contextFor(agentRequest()));
        return currentGrantId();
      });
      expect(seen).toBe(raised.proposalId);
    });
  });

  describe('allow always', () => {
    it('records what was read, and lets that resource through from then on', async () => {
      const { guard, service, concessions } = build(DEPLOY);
      const raised = await refusalOf(
        guard.canActivate(contextFor(agentRequest())),
      );
      const { concession } = await service.decideProposal(
        raised.proposalId as string,
        'owner-1',
        PROPOSAL_DECISION.ALWAYS,
      );

      expect(concession?.sentence).toBe(
        'deploy application app-1 whenever it asks',
      );
      expect(concession?.binding).toEqual({ id: 'app-1' });
      expect(concessions.rows).toHaveLength(1);

      await expect(guard.canActivate(contextFor(agentRequest()))).resolves.toBe(
        true,
      );
      // Different arguments, same resource: a standing permission is about the
      // resource, not about one set of arguments.
      await expect(
        guard.canActivate(
          contextFor(agentRequest({ body: { branch: 'release' } })),
        ),
      ).resolves.toBe(true);
    });

    it('opens a door and not a floor — a second application still asks', async () => {
      const { guard, service } = build(DEPLOY);
      const raised = await refusalOf(
        guard.canActivate(contextFor(agentRequest())),
      );
      await service.decideProposal(
        raised.proposalId as string,
        'owner-1',
        PROPOSAL_DECISION.ALWAYS,
      );

      const other = await refusalOf(
        guard.canActivate(
          contextFor(
            agentRequest({
              path: '/api/v1/applications/app-2/deploy',
              params: { id: 'app-2' },
            }),
          ),
        ),
      );
      expect(other.code).toBe(ACTION_PROPOSAL_CODE);
      expect(other.sentence).toBe('deploy application app-2 whenever it asks');
    });

    it('attributes what it starts to the concession, so a revoke can be informed', async () => {
      const { guard, service, concessions } = build(DEPLOY);
      const raised = await refusalOf(
        guard.canActivate(contextFor(agentRequest())),
      );
      await service.decideProposal(
        raised.proposalId as string,
        'owner-1',
        PROPOSAL_DECISION.ALWAYS,
      );

      const seen = await runWithActorContext(async () => {
        await guard.canActivate(contextFor(agentRequest()));
        return currentGrantId();
      });
      expect(seen).toBe(concessions.rows[0].id);
    });

    it('is not offered at all when the request cannot state its own edge', async () => {
      const { guard, service } = build(NO_EDGE);
      const raised = await refusalOf(
        guard.canActivate(
          contextFor(
            agentRequest({
              path: '/api/v1/applications/deploy-from-yaml',
              params: {},
            }),
          ),
        ),
      );
      expect(raised.offersAlways).toBe(false);
      await expect(
        service.decideProposal(
          raised.proposalId as string,
          'owner-1',
          PROPOSAL_DECISION.ALWAYS,
        ),
      ).rejects.toThrow(/only be allowed once/);
    });
  });

  describe('no', () => {
    it('stands, and tells the agent not to keep trying', async () => {
      const { guard, service } = build(DEPLOY);
      const raised = await refusalOf(
        guard.canActivate(contextFor(agentRequest())),
      );
      await service.decideProposal(
        raised.proposalId as string,
        'owner-1',
        PROPOSAL_DECISION.DENY,
      );

      const again = await refusalOf(
        guard.canActivate(contextFor(agentRequest())),
      );
      expect(again.code).toBe(ACTION_PROPOSAL_DENIED_CODE);
    });
  });

  describe('the applicant does not hold the pen', () => {
    it('refuses an agent credential answering its own request', async () => {
      const { guard, controller } = build(DEPLOY);
      const raised = await refusalOf(
        guard.canActivate(contextFor(agentRequest())),
      );

      const body = await refusalOf(
        controller.decide(
          agentRequest() as never,
          raised.proposalId as string,
          {
            decision: PROPOSAL_DECISION.ALWAYS,
          },
        ),
      );
      expect(body.code).toBe('AGENT_MAY_NOT_DECIDE');
    });

    it('lets the person the agent acts for answer it', async () => {
      const { guard, controller, concessions } = build(DEPLOY);
      const raised = await refusalOf(
        guard.canActivate(contextFor(agentRequest())),
      );
      const answered = await controller.decide(
        personRequest() as never,
        raised.proposalId as string,
        { decision: PROPOSAL_DECISION.ALWAYS },
      );
      expect(answered.proposal.status).toBe(PROPOSAL_STATUS.CONSUMED);
      expect(concessions.rows).toHaveLength(1);
    });

    it("refuses somebody else's request as if it did not exist", async () => {
      const { guard, controller } = build(DEPLOY);
      const raised = await refusalOf(
        guard.canActivate(contextFor(agentRequest())),
      );
      await expect(
        controller.decide(
          personRequest({
            user: { userId: 'stranger', isAdmin: true },
          }) as never,
          raised.proposalId as string,
          { decision: PROPOSAL_DECISION.ALWAYS },
        ),
      ).rejects.toThrow(/not found/);
    });
  });

  /**
   * The assimilation of the two agentic surfaces (decision A9).
   *
   * The division these cases are built to make is the one that decides whether
   * the change is right: what goes RED with the surface taken back out is the
   * proof that the portal's assistant is now governed, and what stays GREEN is
   * the proof that nothing a person types on a form or a CLI has changed. Both
   * halves matter, because the failure this risks is stopping a function that
   * has to work.
   */
  describe('the portal assistant is an agent too', () => {
    it('stops it and raises the same request an external agent gets', async () => {
      const { guard, proposals } = build(DEPLOY);
      const body = await refusalOf(
        guard.canActivate(contextFor(assistantRequest())),
      );

      expect(body.code).toBe(ACTION_PROPOSAL_CODE);
      expect(body.sentence).toBe('deploy application app-1 whenever it asks');
      expect(proposals.rows).toHaveLength(1);
      expect(proposals.rows[0].ownerUserId).toBe('owner-1');
    });

    it('has an identity to hang a standing permission on, so it can be told "always"', async () => {
      // Without one the request could only ever be answered "once" and the
      // copilot would ask the identical question every single turn.
      const { guard, proposals } = build(DEPLOY);
      const body = await refusalOf(
        guard.canActivate(contextFor(assistantRequest())),
      );
      expect(body.offersAlways).toBe(true);
      expect(proposals.rows[0].keyId).toBe(ASSISTANT_AGENT_KEY_ID);
    });

    it('lets the person answer it, and then stops asking', async () => {
      const { guard, controller, concessions } = build(DEPLOY);
      const raised = await refusalOf(
        guard.canActivate(contextFor(assistantRequest())),
      );
      // Answered from the dashboard: the same person, on a request of their
      // own making — no surface declared, because a person filling in a form
      // is not an agent.
      await controller.decide(
        personRequest() as never,
        raised.proposalId as string,
        { decision: PROPOSAL_DECISION.ALWAYS },
      );
      expect(concessions.rows).toHaveLength(1);
      expect(concessions.rows[0].keyId).toBe(ASSISTANT_AGENT_KEY_ID);

      await expect(
        guard.canActivate(contextFor(assistantRequest())),
      ).resolves.toBe(true);
    });

    it('opens a door and not a floor — another application still asks', async () => {
      const { guard, controller } = build(DEPLOY);
      const raised = await refusalOf(
        guard.canActivate(contextFor(assistantRequest())),
      );
      await controller.decide(
        personRequest() as never,
        raised.proposalId as string,
        { decision: PROPOSAL_DECISION.ALWAYS },
      );

      const other = await refusalOf(
        guard.canActivate(
          contextFor(
            assistantRequest({
              path: '/api/v1/applications/app-2/deploy',
              params: { id: 'app-2' },
            }),
          ),
        ),
      );
      expect(other.code).toBe(ACTION_PROPOSAL_CODE);
    });

    it('cannot answer its own request, even though it holds the person credential', async () => {
      // The line without which the whole cycle is a formality performed on
      // itself. It reads the actor, so it now covers a tool of the assistant
      // reaching the decision route exactly as it covers an external agent.
      const { guard, controller } = build(DEPLOY);
      const raised = await refusalOf(
        guard.canActivate(contextFor(assistantRequest())),
      );
      const body = await refusalOf(
        controller.decide(
          assistantRequest() as never,
          raised.proposalId as string,
          { decision: PROPOSAL_DECISION.ONCE },
        ),
      );
      expect(body.code).toBe('AGENT_MAY_NOT_DECIDE');
    });

    it('leaves the same person on the same route untouched when they type it themselves', async () => {
      // The dashboard form and `flui app deploy`. A pause between "she wrote
      // the arguments" and "she confirms the arguments" is theatre, and this is
      // the case the change must not touch.
      const { guard, proposals } = build(DEPLOY);
      await expect(
        guard.canActivate(contextFor(personRequest())),
      ).resolves.toBe(true);
      expect(proposals.rows).toHaveLength(0);
    });

    it('is not something a client can assert about itself', async () => {
      const { guard, proposals } = build(DEPLOY);
      await expect(
        guard.canActivate(
          contextFor(
            personRequest({
              headers: { [AGENT_SURFACE_HEADER]: 'assistant' },
            }),
          ),
        ),
      ).resolves.toBe(true);
      expect(proposals.rows).toHaveLength(0);
    });
  });

  describe('taking a permission back', () => {
    it('stops the next departure immediately', async () => {
      const { guard, service, concessions } = build(DEPLOY);
      const raised = await refusalOf(
        guard.canActivate(contextFor(agentRequest())),
      );
      await service.decideProposal(
        raised.proposalId as string,
        'owner-1',
        PROPOSAL_DECISION.ALWAYS,
      );
      await expect(guard.canActivate(contextFor(agentRequest()))).resolves.toBe(
        true,
      );

      await service.revoke(concessions.rows[0].id, 'owner-1');

      const after = await refusalOf(
        guard.canActivate(contextFor(agentRequest())),
      );
      expect(after.code).toBe(ACTION_PROPOSAL_CODE);
      // Not even one more. Falsifying this is what found the leak: saying
      // "always" used to leave a spendable one-off approval beside the
      // concession, and the guard would have found it after the revoke.
      expect(after.proposalId).not.toBe(raised.proposalId);
    });

    it('never aborts what has already left, and says what is still running', async () => {
      const { service, concessions, operations } = build(DEPLOY);
      await concessions.save({
        id: 'grant-1',
        ownerUserId: 'owner-1',
        keyId: 'key-1',
        action: DEPLOY.action,
        sentence: 's',
      } as AgentConcessionEntity);
      await operations.save({
        id: 'op-1',
        grantId: 'grant-1',
        status: OperationStatus.IN_PROGRESS,
      });

      const result = await service.revoke('grant-1', 'owner-1');
      expect(result.stillRunning).toEqual(['op-1']);
      expect(result.stopRequested).toEqual([]);
      expect(operations.rows[0].cancelRequestedAt).toBeUndefined();
      expect(operations.rows[0].status).toBe(OperationStatus.IN_PROGRESS);
    });

    it('asks them to stop only when the person asks for that too', async () => {
      const { service, concessions, operations } = build(DEPLOY);
      await concessions.save({
        id: 'grant-1',
        ownerUserId: 'owner-1',
        keyId: 'key-1',
        action: DEPLOY.action,
        sentence: 's',
      } as AgentConcessionEntity);
      await operations.save({
        id: 'op-1',
        grantId: 'grant-1',
        status: OperationStatus.IN_PROGRESS,
        cancelRequestedAt: null,
      });

      const result = await service.revoke('grant-1', 'owner-1', true);
      expect(result.stopRequested).toEqual(['op-1']);
      expect(operations.rows[0].cancelRequestedAt).toBeInstanceOf(Date);
      // Still a request: the status is not touched here. Whoever is running the
      // work honours it at its next step boundary, so a half-finished step does
      // not leave paid-for debris behind.
      expect(operations.rows[0].status).toBe(OperationStatus.IN_PROGRESS);
    });
  });
});

/**
 * The sentence a person answers, when what the action does is in the body.
 *
 * `renderSentence` fills from route parameters, and some actions carry their
 * whole meaning somewhere else: the level a note is written at — one cluster, or
 * every tenant and every guest of the demonstration — arrives as a field. What
 * was being approved was the verb without the blast radius.
 */
describe('what the body adds to the sentence', () => {
  const declaring = (clause: (body: unknown) => string | undefined) => ({
    action: 'POST /things/:id/notes',
    bind: ['id'],
    sentence: 'write a note on {id}',
    clause,
  });

  const posting = () =>
    agentRequest({
      path: '/api/v1/things/t-1/notes',
      params: { id: 't-1' },
      body: { level: 'global' },
    });

  const saysLevel = (body: unknown) =>
    (body as { level?: string }).level === 'global'
      ? 'everyone on this installation reads it'
      : undefined;

  it('is read to the person, not just the verb', async () => {
    const { guard } = build(declaring(saysLevel));
    const raised = await refusalOf(guard.canActivate(contextFor(posting())));

    expect(raised.sentence).toBe(
      'write a note on t-1 — everyone on this installation reads it',
    );
    expect(raised.message).toContain('everyone on this installation reads it');
  });

  /**
   * The property the concessions hang from: the sentence is the one that was
   * read at the yes, stored to the letter. The body is hashed and dropped when
   * the request is raised, so a clause that answers differently tomorrow can no
   * longer reach a permission somebody already gave.
   */
  it('is frozen where it was read, not recomputed at the answer', async () => {
    let says = 'everyone on this installation reads it';
    const { guard, service } = build(declaring(() => says));
    const raised = await refusalOf(guard.canActivate(contextFor(posting())));

    says = 'only you read it';
    const { proposal, concession } = await service.decideProposal(
      raised.proposalId as string,
      'owner-1',
      PROPOSAL_DECISION.ALWAYS,
    );

    expect(proposal.sentence).toBe(raised.sentence);
    expect(concession?.sentence).toBe(raised.sentence);
    expect(concession?.sentence).toContain(
      'everyone on this installation reads it',
    );
  });

  it('leaves a route that declares no clause exactly as it was', async () => {
    const { guard } = build(DEPLOY);
    const raised = await refusalOf(
      guard.canActivate(contextFor(agentRequest())),
    );
    expect(raised.sentence).toBe('deploy application app-1 whenever it asks');
  });

  /**
   * Guards run before the validation pipe, so a clause is handed whatever was
   * posted. It must not be able to turn a 400 into a 500, or to stop a request
   * the person would otherwise have been asked about.
   */
  it('still raises the request when the clause cannot read the body', async () => {
    const { guard, proposals } = build(
      declaring(() => {
        throw new Error('unvalidated body');
      }),
    );
    const raised = await refusalOf(guard.canActivate(contextFor(posting())));

    expect(raised.code).toBe(ACTION_PROPOSAL_CODE);
    expect(raised.sentence).toBe('write a note on t-1');
    expect(proposals.rows).toHaveLength(1);
  });
});

/**
 * The register, written from the door.
 *
 * The measured defect: an agent using its key over plain HTTP left no row at
 * all, because `mcp_tool_call_logs` was written by the MCP surface and by the
 * assistant and by nothing else. The cycle stopped those calls anyway — the
 * gate is in the guard chain, not in the tool — so nothing was open; what was
 * broken is the panel's promise, *what your agent did*, on exactly the calls
 * this guard exists to catch.
 *
 * The division this block is built to make is the same one the suite above
 * makes: rows that must appear, and rows that must NOT — a person's call, a
 * second copy of a call a surface already recorded, and any call at all when
 * the register itself is down.
 */
describe('what the door writes down', () => {
  const KEY_ID = 'key-1';

  it("records an agent's stopped write, with the request it raised", async () => {
    const { guard, audit } = build(DEPLOY, 'app:write');
    const raised = await refusalOf(
      guard.canActivate(contextFor(agentRequest())),
    );

    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      userId: 'owner-1',
      surface: REGISTER_SURFACE.API,
      // The declared shape, never the concrete path: it is the string a
      // standing permission is stored under, so both name the same thing.
      tool: 'POST /applications/:id/deploy',
      scope: 'app:write',
      allowed: true,
      outcome: 'input_required',
      proposalId: raised.proposalId,
      error: ACTION_PROPOSAL_CODE,
      actor: { kind: 'agent', keyId: KEY_ID },
    });
    // The body is hashed and dropped by the cycle; a `catalog_install` carries
    // an administrator password in it and this table is built to be read.
    expect(audit.rows[0].args).toBeNull();
  });

  /**
   * Decision 152, mechanically: a row that declares the wrong permission is
   * worse than a row that admits it does not know one.
   */
  it('says so when the route declares no permission, instead of guessing one', async () => {
    const { guard, audit } = build(DEPLOY);
    await refusalOf(guard.canActivate(contextFor(agentRequest())));
    expect(audit.rows[0].scope).toBe(PERMISSION_UNSTATED);
  });

  it('records the departure under a spent "allow once", and names it', async () => {
    const { guard, service, audit } = build(DEPLOY, 'app:write');
    const raised = await refusalOf(
      guard.canActivate(contextFor(agentRequest())),
    );
    await service.decideProposal(
      raised.proposalId as string,
      'owner-1',
      PROPOSAL_DECISION.ONCE,
    );
    await guard.canActivate(contextFor(agentRequest()));

    expect(audit.rows).toHaveLength(2);
    expect(audit.rows[1]).toMatchObject({
      surface: REGISTER_SURFACE.API,
      allowed: true,
      // Not `null`: a guard runs before the handler, so "allowed and no error"
      // would claim a success this row cannot have observed.
      outcome: OUTCOME_DEPARTED,
      error: null,
      // The verdict, on the row. A guard runs before the handler and never
      // learns what it created, so the operation the other surfaces reach this
      // fact through does not exist yet.
      grantId: raised.proposalId,
    });
  });

  it('records the departure under a standing permission, and names that', async () => {
    const { guard, service, audit } = build(DEPLOY, 'app:write');
    const raised = await refusalOf(
      guard.canActivate(contextFor(agentRequest())),
    );
    const { concession } = await service.decideProposal(
      raised.proposalId as string,
      'owner-1',
      PROPOSAL_DECISION.ALWAYS,
    );
    await guard.canActivate(contextFor(agentRequest()));

    expect(audit.rows[1]).toMatchObject({
      allowed: true,
      grantId: concession?.id,
    });
  });

  it('records a call the person had already refused, as a refusal', async () => {
    const { guard, service, audit } = build(DEPLOY, 'app:write');
    const raised = await refusalOf(
      guard.canActivate(contextFor(agentRequest())),
    );
    await service.decideProposal(
      raised.proposalId as string,
      'owner-1',
      PROPOSAL_DECISION.DENY,
    );
    const again = await refusalOf(
      guard.canActivate(contextFor(agentRequest())),
    );

    expect(again.code).toBe(ACTION_PROPOSAL_DENIED_CODE);
    expect(audit.rows[1]).toMatchObject({
      allowed: false,
      outcome: null,
      error: ACTION_PROPOSAL_DENIED_CODE,
      proposalId: raised.proposalId,
    });
  });

  /**
   * The one that keeps the panel's counts honest. A tool reaches the product
   * over a loopback hop that declares its surface, and that hop already wrote a
   * row — with the tool's name on it, which is the more useful of the two.
   */
  it('writes nothing when a surface already claimed the call', async () => {
    for (const surface of ['mcp', 'assistant'] as const) {
      const { guard, audit } = build(DEPLOY, 'app:write');
      await refusalOf(
        guard.canActivate(
          contextFor(
            agentRequest({
              headers: { [AGENT_SURFACE_HEADER]: agentSurfaceHeader(surface) },
            }),
          ),
        ),
      );
      expect(audit.rows).toHaveLength(0);
    }
  });

  it('writes nothing for a person, an unscoped key, or an undecorated route', async () => {
    const person = build(DEPLOY, 'app:write');
    await person.guard.canActivate(contextFor(personRequest()));
    expect(person.audit.rows).toHaveLength(0);

    const cli = build(DEPLOY, 'app:write');
    const req = agentRequest();
    (req.user as { scopes: string[] }).scopes = [];
    await cli.guard.canActivate(contextFor(req));
    expect(cli.audit.rows).toHaveLength(0);

    const plain = build(undefined, 'app:write');
    await plain.guard.canActivate(contextFor(agentRequest()));
    expect(plain.audit.rows).toHaveLength(0);
  });

  /**
   * A register that cannot be written is a register that is missing a row, and
   * nothing worse than that. Turning a bookkeeping failure into a refusal would
   * make the audit trail a way to take the product down — the same reason the
   * cycle stamps a concession as used and swallows the failure.
   */
  it('never refuses a call because the register is down', async () => {
    const allowed = build(DEPLOY, 'app:write');
    allowed.audit.fail = true;
    const raised = await refusalOf(
      allowed.guard.canActivate(contextFor(agentRequest())),
    );
    await allowed.service.decideProposal(
      raised.proposalId as string,
      'owner-1',
      PROPOSAL_DECISION.ONCE,
    );
    await expect(
      allowed.guard.canActivate(contextFor(agentRequest())),
    ).resolves.toBe(true);
  });

  /** And a refusal still reaches the caller whole when the write fails. */
  it('never swallows a refusal because the register is down', async () => {
    const { guard, audit } = build(DEPLOY, 'app:write');
    audit.fail = true;
    const raised = await refusalOf(
      guard.canActivate(contextFor(agentRequest())),
    );
    expect(raised.code).toBe(ACTION_PROPOSAL_CODE);
    expect(raised.sentence).toBe('deploy application app-1 whenever it asks');
  });
});
