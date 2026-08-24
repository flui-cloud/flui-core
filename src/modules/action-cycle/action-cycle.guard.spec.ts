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
  currentGrantId,
  runWithActorContext,
} from '../auth/utils/actor-context';
import { OperationStatus } from '../infrastructure/servers/entities/infrastructure-operations.entity';

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

interface Cast {
  guard: ActionCycleGuard;
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

function build(decl: ActionCycleDecl | undefined): Cast {
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
    getAllAndOverride: () => decl,
  } as unknown as Reflector;
  return {
    guard: new ActionCycleGuard(reflector, service),
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
