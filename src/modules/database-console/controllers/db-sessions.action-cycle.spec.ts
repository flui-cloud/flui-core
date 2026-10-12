jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));

import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FindOperator } from 'typeorm';
import { DbSessionsController } from './db-sessions.controller';
import { DbPoolerClientsController } from './db-pooler-clients.controller';
import { ActionCycleGuard } from '../../action-cycle/action-cycle.guard';
import { ActionCycleService } from '../../action-cycle/action-cycle.service';
import {
  ACTION_CYCLE_KEY,
  ActionCycleDecl,
} from '../../action-cycle/action-cycle.decorator';
import { ACTION_PROPOSAL_CODE } from '../../action-cycle/action-cycle.core';
import { REQUIRED_PERMISSION_KEY } from '../../iam/decorators/require-permission.decorator';
import { CURRENT_API_KEY_ID } from '../../auth/strategies/api-key.strategy';
import { AgentCallRegister } from '../../mcp/audit/agent-call-register';

class Repo {
  rows: Record<string, unknown>[] = [];
  private seq = 0;
  create(p: Record<string, unknown>) {
    return { ...p };
  }
  save(row: Record<string, unknown>) {
    if (!row.id) {
      row.id = `row-${++this.seq}`;
      row.createdAt = new Date();
      this.rows.push(row);
    }
    return Promise.resolve(row);
  }
  find(o?: { where?: Record<string, unknown> | Record<string, unknown>[] }) {
    const clauses = o?.where ? [o.where].flat() : [];
    if (!clauses.length) return Promise.resolve([...this.rows]);
    return Promise.resolve(
      this.rows.filter((r) =>
        clauses.some((c) =>
          Object.entries(c).every(([k, v]) =>
            v instanceof FindOperator
              ? v.type === 'isNull'
                ? r[k] == null
                : true
              : r[k] === v,
          ),
        ),
      ),
    );
  }
  async findOne(o: { where: Record<string, unknown> }) {
    const found = await this.find(o);
    return found.at(-1) ?? null;
  }
  update() {
    return Promise.resolve({ affected: 0 });
  }
}

const declOf = (name: 'cancel' | 'terminate'): ActionCycleDecl =>
  Reflect.getMetadata(
    ACTION_CYCLE_KEY,
    DbSessionsController.prototype[name] as object,
  ) as ActionCycleDecl;

function guardFor(decl: ActionCycleDecl) {
  const proposals = new Repo();
  const service = new ActionCycleService(
    proposals as never,
    new Repo() as never,
    new Repo() as never,
    { get: () => 'https://console.test' } as never,
  );
  const reflector = {
    getAllAndOverride: (key: string) =>
      key === REQUIRED_PERMISSION_KEY ? 'app:write' : decl,
  } as unknown as Reflector;
  const guard = new ActionCycleGuard(
    reflector,
    service,
    new AgentCallRegister({ record: () => Promise.resolve() } as never),
  );
  return { guard, proposals };
}

const request = (name: string, scopes: string[]) => ({
  user: {
    userId: 'owner-1',
    email: 'owner@test',
    role: 'user',
    isAdmin: false,
    scopes,
  },
  [CURRENT_API_KEY_ID]: 'key-1',
  method: 'POST',
  path: `/api/v1/applications/db-1/db/sessions/42/${name}`,
  params: { id: 'db-1', pid: '42' },
  body: { backendStart: '2026-10-12T07:00:00.123Z' },
});

const contextFor = (req: unknown): ExecutionContext =>
  ({
    getType: () => 'http',
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => req }),
  }) as unknown as ExecutionContext;

describe('ending a database session from an agent', () => {
  it.each([
    ['cancel', 'cancel the query running in session 42 of database db-1'],
    ['terminate', 'close session 42 of database db-1'],
  ] as const)(
    '%s becomes a proposal a person decides on',
    async (name, sentence) => {
      const { guard, proposals } = guardFor(declOf(name));
      let refusal: Record<string, unknown> | undefined;
      try {
        await guard.canActivate(contextFor(request(name, ['mcp:app:write'])));
      } catch (e) {
        expect(e).toBeInstanceOf(ForbiddenException);
        refusal = (e as ForbiddenException).getResponse() as Record<
          string,
          unknown
        >;
      }
      expect(refusal?.code).toBe(ACTION_PROPOSAL_CODE);
      expect(refusal?.sentence).toBe(sentence);
      expect(proposals.rows).toHaveLength(1);
    },
  );

  it('lets a person through: the dashboard and the CLI confirm on their own side', async () => {
    const { guard, proposals } = guardFor(declOf('terminate'));
    await expect(
      guard.canActivate(
        contextFor(request('terminate', ['openid', 'profile'])),
      ),
    ).resolves.toBe(true);
    expect(proposals.rows).toHaveLength(0);
  });

  it('closing a pooled connection becomes a proposal too', async () => {
    const decl = Reflect.getMetadata(
      ACTION_CYCLE_KEY,
      DbPoolerClientsController.prototype.close as object,
    ) as ActionCycleDecl;
    const { guard, proposals } = guardFor(decl);
    const req = {
      ...request('close', ['mcp:app:write']),
      path: '/api/v1/applications/db-1/db/pooler/clients/5/close',
      params: { id: 'db-1', clientId: '5' },
      body: { pod: 'pg-pooler-1', connectTime: '2026-10-12 07:00:00 UTC' },
    };
    await expect(guard.canActivate(contextFor(req))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(proposals.rows).toHaveLength(1);
    expect(proposals.rows[0].sentence).toBe(
      'close pooled connection 5 of database db-1',
    );
  });
});
