/* eslint-disable sonarjs/assertions-in-tests --
   The assertion here is supertest's own `.expect(status)`, which throws on a
   mismatch. The rule only recognises a global `expect()` and reads these as
   assertion-free. */

// The guard's import graph reaches ESM-only packages (Kubernetes client, jose
// via jwks-rsa) that ts-jest cannot transform; stub them — this suite touches
// none of them.
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));

import {
  Body,
  Controller,
  INestApplication,
  Param,
  Post,
  ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { FindOperator } from 'typeorm';
import { HttpExceptionFilter } from '../../../filters/http-exception.filter';
import { ActionCycle } from '../../action-cycle/action-cycle.decorator';
import { ActionCycleGuard } from '../../action-cycle/action-cycle.guard';
import { ActionCycleService } from '../../action-cycle/action-cycle.service';
import { ACTION_PROPOSAL_CODE } from '../../action-cycle/action-cycle.core';
import { CURRENT_API_KEY_ID } from '../../auth/strategies/api-key.strategy';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { McpAuditRepository } from '../repositories/mcp-audit.repository';
import { McpToolCallLogEntity } from '../entities/mcp-tool-call-log.entity';
import { AgentActivityController } from './agent-activity.controller';
import { AgentActivityService } from './agent-activity.service';
import { AgentCallRegister } from './agent-call-register';
import { REGISTER_SURFACE } from './register-surface';

/**
 * The seam this round exists to prove.
 *
 * Everything below is real: the guard, the cycle, the repository's own mapping
 * from a `record()` call to the entity's columns, the read back, the DTO and
 * the JSON that leaves over HTTP. Only the SQL execution is stubbed, and the
 * SQL itself is asserted next door in `agent-activity.sql.spec.ts` — a mock
 * repository cannot be wrong about a column name.
 *
 * It is here because the register is read by a panel *through the API*, and
 * three defects in this series were found in exactly that gap: a mechanism with
 * green tests that never reached the wire. A row that exists in the table and
 * not in the response is the defect this round was sent to fix, one layer
 * further in.
 */

const DEPLOY = 'POST /applications/:id/deploy';
const OWNER = 'owner-1';
const KEY_ID = 'key-1';

@Controller('applications')
class DeployController {
  @Post(':id/deploy')
  @RequirePermission('app:write')
  @ActionCycle({
    action: DEPLOY,
    bind: ['id'],
    sentence: 'deploy application {id} whenever it asks',
  })
  deploy(@Param('id') id: string, @Body() body: unknown): unknown {
    return { id, body, deployed: true };
  }
}

/** Enough of TypeORM to run the real repository against an array. */
class FakeTable {
  rows: McpToolCallLogEntity[] = [];
  private seq = 0;

  create(partial: Partial<McpToolCallLogEntity>): McpToolCallLogEntity {
    return { ...partial } as McpToolCallLogEntity;
  }

  save(row: McpToolCallLogEntity): Promise<McpToolCallLogEntity> {
    row.id = `00000000-0000-4000-8000-00000000000${++this.seq}`;
    row.created_at = new Date();
    this.rows.push(row);
    return Promise.resolve(row);
  }

  findOne(): Promise<McpToolCallLogEntity | null> {
    return Promise.resolve(this.rows[0] ?? null);
  }

  createQueryBuilder(): unknown {
    const params: Record<string, unknown> = {};
    // Newest first, the way the real repository orders it — the panel reads a
    // page top-down and a suite that asserted on insertion order would be
    // asserting about this fake.
    const rows = () =>
      this.rows
        .filter((row) => !params.userId || row.user_id === params.userId)
        .slice()
        .reverse();
    const qb: Record<string, unknown> = {
      andWhere: (_sql: string, bound?: Record<string, unknown>) => {
        Object.assign(params, bound ?? {});
        return qb;
      },
      orderBy: () => qb,
      addOrderBy: () => qb,
      take: () => qb,
      skip: () => qb,
      getManyAndCount: () => Promise.resolve([rows(), rows().length]),
    };
    return qb;
  }
}

interface Wire {
  app: INestApplication;
  table: FakeTable;
  cycle: ActionCycleService;
}

async function stand(): Promise<Wire> {
  const table = new FakeTable();
  const audit = new McpAuditRepository(table as never);
  const proposals = new FakeRows();
  const concessions = new FakeRows();
  const cycle = new ActionCycleService(
    proposals as never,
    concessions as never,
    new FakeRows() as never,
    { get: () => 'https://console.test' } as never,
  );

  const moduleRef = await Test.createTestingModule({
    controllers: [DeployController, AgentActivityController],
    providers: [
      { provide: APP_GUARD, useClass: ActionCycleGuard },
      { provide: AgentCallRegister, useValue: new AgentCallRegister(audit) },
      { provide: ActionCycleService, useValue: cycle },
      {
        provide: AgentActivityService,
        useValue: new AgentActivityService(
          audit,
          { find: async () => [] } as never,
          { find: async () => [] } as never,
          { find: async () => [] } as never,
          {
            resolveAccess: async () => ({ isAdmin: false }),
            can: () => false,
          } as never,
        ),
      },
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  // The two pieces of `main.ts` that stand between a handler and the wire, and
  // the reason this suite exists at all: decision 188 was a contract the guard
  // threw and the filter dropped, with the guard's own tests green.
  app.useGlobalPipes(new ValidationPipe({ transform: true }));
  app.useGlobalFilters(new HttpExceptionFilter());
  // Stands in for the auth guard: the same person either way, and the header
  // decides whether this call carries the agent credential or the browser
  // session. Nothing else about the two requests differs, which is the point.
  app.use(
    (
      req: { headers: Record<string, string>; user?: unknown },
      _res: unknown,
      next: () => void,
    ) => {
      const asAgent = req.headers['x-test-actor'] === 'agent';
      req.user = {
        userId: OWNER,
        email: 'owner@test',
        isAdmin: false,
        scopes: asAgent ? ['mcp:app:write'] : ['openid', 'profile'],
      };
      if (asAgent) {
        (req as Record<symbol, unknown>)[CURRENT_API_KEY_ID] = KEY_ID;
      }
      next();
    },
  );
  await app.init();
  return { app, table, cycle };
}

/** The cycle's three tables, as far as this suite asks anything of them. */
class FakeRows {
  rows: Record<string, unknown>[] = [];
  private seq = 0;

  create(partial: Record<string, unknown>): Record<string, unknown> {
    return { ...partial };
  }

  save(row: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!row.id) {
      row.id = `row-${++this.seq}`;
      this.rows.push(row);
    }
    return Promise.resolve(row);
  }

  find(options?: {
    where?: Record<string, unknown>;
  }): Promise<Record<string, unknown>[]> {
    return Promise.resolve(this.rows.filter(matching(options?.where)));
  }

  async findOne(options?: {
    where?: Record<string, unknown>;
  }): Promise<Record<string, unknown> | null> {
    const found = await this.find(options);
    return found.length ? found[found.length - 1] : null;
  }

  update(
    criteria: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): Promise<{ affected: number }> {
    const hits = this.rows.filter(matching(criteria));
    for (const row of hits) Object.assign(row, patch);
    return Promise.resolve({ affected: hits.length });
  }
}

/** Equality, plus the one operator the cycle asks with: `IsNull()`. */
function matching(where: Record<string, unknown> | undefined) {
  return (row: Record<string, unknown>): boolean =>
    Object.entries(where ?? {}).every(([key, expected]) =>
      expected instanceof FindOperator
        ? row[key] === null || row[key] === undefined
        : row[key] === expected,
    );
}

describe('the register, all the way to the response', () => {
  let wire: Wire;

  beforeEach(async () => {
    wire = await stand();
  });

  afterEach(async () => {
    await wire.app.close();
  });

  it('is empty before the agent does anything', async () => {
    const { body } = await request(wire.app.getHttpServer())
      .get('/agent/activity')
      .expect(200);
    expect(body).toMatchObject({ scope: 'own', total: 0, entries: [] });
  });

  /**
   * The measured defect, end to end: five real agent calls over plain HTTP and
   * `/agent/activity` answered with zero rows. The call is stopped by the cycle
   * either way — that was never in question — and the panel said nothing.
   */
  it("shows an agent's stopped write to the person it was made for", async () => {
    const refused = await request(wire.app.getHttpServer())
      .post('/applications/app-1/deploy')
      .set('x-test-actor', 'agent')
      .send({ branch: 'main' })
      .expect(403);
    expect(refused.body.code).toBe(ACTION_PROPOSAL_CODE);

    const { body } = await request(wire.app.getHttpServer())
      .get('/agent/activity')
      .expect(200);

    expect(body.total).toBe(1);
    expect(body.entries[0]).toMatchObject({
      surface: REGISTER_SURFACE.API,
      tool: DEPLOY,
      // The permission the gate three doors up actually checked, read off the
      // same metadata — not a plausible-looking guess.
      scope: 'app:write',
      actorKind: 'agent',
      actorKeyId: KEY_ID,
      outcome: 'input_required',
      raisedProposalId: refused.body.proposalId,
      underAbsent: 'waiting',
    });
    // The stored `error` is a code out of Flui's own vocabulary, so it crosses
    // the disclosure boundary intact without widening it by a character.
    expect(body.entries[0].error).toBe(ACTION_PROPOSAL_CODE);
    expect(body.entries[0].errorWithheld).toBe(false);
  });

  it('narrows to the door the call came through', async () => {
    await request(wire.app.getHttpServer())
      .post('/applications/app-1/deploy')
      .set('x-test-actor', 'agent')
      .send({ branch: 'main' })
      .expect(403);

    await request(wire.app.getHttpServer())
      .get('/agent/activity?surface=api')
      .expect(200);
    // A surface outside the closed set is a 400, not an empty page: the panel
    // must not be able to ask a question the register cannot answer.
    await request(wire.app.getHttpServer())
      .get('/agent/activity?surface=curl')
      .expect(400);
  });

  /**
   * The whole round trip, as the live validation walked it: the agent is
   * stopped, the person answers once, the agent retries the identical call and
   * it goes through — and the panel shows both halves, the second one naming
   * what let it past.
   *
   * The join behind that second row exists nowhere else: a guard runs before
   * the handler, so there is no operation to reach the answer through, and
   * without the column on the row the register would know the call happened and
   * be unable to say what allowed it.
   */
  it('shows the retry that went through, and what let it', async () => {
    const refused = await request(wire.app.getHttpServer())
      .post('/applications/app-1/deploy')
      .set('x-test-actor', 'agent')
      .send({ branch: 'main' })
      .expect(403);
    await wire.cycle.decideProposal(
      refused.body.proposalId as string,
      OWNER,
      'once',
    );

    await request(wire.app.getHttpServer())
      .post('/applications/app-1/deploy')
      .set('x-test-actor', 'agent')
      .send({ branch: 'main' })
      .expect(201);

    const { body } = await request(wire.app.getHttpServer())
      .get('/agent/activity')
      .expect(200);
    expect(body.total).toBe(2);
    expect(body.entries[0]).toMatchObject({
      surface: REGISTER_SURFACE.API,
      allowed: true,
      // Not "it succeeded": the door writes before the handler runs.
      outcome: 'departed',
      under: 'approval',
      proposalId: refused.body.proposalId,
      underAbsent: null,
    });
  });

  /** A person's own call is not an agent's, and leaves the register alone. */
  it('writes nothing when the same person deploys from the dashboard', async () => {
    await request(wire.app.getHttpServer())
      .post('/applications/app-1/deploy')
      .set('x-test-actor', 'person')
      .send({ branch: 'main' })
      .expect(201);

    expect(wire.table.rows).toHaveLength(0);
    const { body } = await request(wire.app.getHttpServer())
      .get('/agent/activity')
      .expect(200);
    expect(body.entries).toEqual([]);
  });
});
