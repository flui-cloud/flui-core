jest.mock('@kubernetes/client-node', () => ({}));

import { NotFoundException } from '@nestjs/common';
import { VisitorSweepService } from './visitor-sweep.service';
import { loadVisitorConfig } from './visitor.config';

type Row = { userId: string; idpUserId: string };

describe('VisitorSweepService', () => {
  const build = (
    due: Row[],
    state: {
      locked?: (id: string) => unknown;
      visitorRow?: (id: string) => Row | null;
    } = {},
  ) => {
    const conditions: unknown[] = [];
    const qb = {
      innerJoinAndSelect: () => qb,
      where: (c: unknown) => (conditions.push(c), qb),
      andWhere: (c: unknown, p?: unknown) => (conditions.push([c, p]), qb),
      orderBy: () => qb,
      limit: (n: number) => (conditions.push(['limit', n]), qb),
      getMany: async () => due,
    };
    const calls: string[] = [];
    const repos: Record<string, unknown> = {
      UserEntity: {
        findOne: async ({ where }: { where: { id: string } }) => {
          calls.push(`lock ${where.id}`);
          return state.locked
            ? state.locked(where.id)
            : { id: where.id, isAdmin: false };
        },
        delete: async (w: unknown) => calls.push(`users ${JSON.stringify(w)}`),
      },
      SandboxVisitorEntity: {
        findOne: async ({ where }: { where: { userId: string } }) =>
          state.visitorRow
            ? state.visitorRow(where.userId)
            : (due.find((d) => d.userId === where.userId) ?? null),
        update: async (w: unknown, v: Record<string, unknown>) =>
          calls.push(
            `visitors ${JSON.stringify(w)} removedAt=${v.removedAt instanceof Date} ipHash=${String(v.ipHash)}`,
          ),
      },
    };
    for (const name of [
      'ApiKeyEntity',
      'IamRoleBindingEntity',
      'ActionProposalEntity',
      'AgentConcessionEntity',
    ]) {
      repos[name] = {
        delete: async (w: unknown) =>
          calls.push(`${name} ${JSON.stringify(w)}`),
        update: async (w: unknown, v: unknown) =>
          calls.push(`${name} ${JSON.stringify(w)} -> ${JSON.stringify(v)}`),
      };
    }
    const manager = {
      getRepository: (entity: { name: string }) => repos[entity.name],
    };
    let committed = 0;
    const dataSource = {
      transaction: async (work: (m: unknown) => Promise<unknown>) => {
        const result = await work(manager);
        committed += 1;
        return result;
      },
    };
    const directory = {
      deleteUser: jest.fn(async (id: string) => {
        calls.push(`idp ${id}`);
        if (id === 'gone') throw new NotFoundException();
        if (id === 'down') throw new Error('provider down');
      }),
    };
    const admissions = { purgeExpired: jest.fn(async () => 0) };
    const service = new VisitorSweepService(
      loadVisitorConfig({}),
      { createQueryBuilder: () => qb } as never,
      dataSource as never,
      directory as never,
      {
        removePersonal: async (id: string) => calls.push(`project ${id}`),
      } as never,
      admissions as never,
    );
    return {
      service,
      calls,
      conditions,
      admissions,
      committed: () => committed,
    };
  };

  it('removes a visitor who left, under its lock, keeping its row as a record and its keys revoked', async () => {
    const t = build([{ userId: 'u1', idpUserId: 'idp1' }]);
    const now = new Date('2026-10-13T12:00:00Z');
    expect(await t.service.sweep(now)).toBe(1);
    expect(t.admissions.purgeExpired).toHaveBeenCalledWith(now);
    expect(t.calls).toEqual([
      'lock u1',
      'ApiKeyEntity {"userId":"u1","revoked":false} -> {"revoked":true}',
      'IamRoleBindingEntity {"principalType":"user","principalRef":"u1"}',
      'ActionProposalEntity {"ownerUserId":"u1"}',
      'AgentConcessionEntity {"ownerUserId":"u1"}',
      'idp idp1',
      'visitors {"userId":"u1"} removedAt=true ipHash=null',
      'users {"id":"u1","kind":"visitor"}',
      'project u1',
    ]);
    const text = JSON.stringify(t.conditions);
    expect(text).toContain('upgradedAt');
    expect(text).toContain('removedAt');
    expect(text).toContain('"2026-10-11T12:00:00.000Z"');
    expect(text).toContain('"2026-10-06T12:00:00.000Z"');
    expect(text).toContain('["limit",50]');
  });

  it('carries on when the provider already forgot the visitor', async () => {
    const t = build([{ userId: 'u1', idpUserId: 'gone' }]);
    expect(await t.service.sweep()).toBe(1);
    expect(t.calls).toContain('users {"id":"u1","kind":"visitor"}');
  });

  it('skips a visitor that became an account while it waited for the lock', async () => {
    const t = build([{ userId: 'u1', idpUserId: 'idp1' }], {
      locked: () => null,
    });
    expect(await t.service.sweep()).toBe(0);
    expect(t.calls).toEqual(['lock u1']);
  });

  it('skips a visitor whose row was upgraded or already removed', async () => {
    const t = build([{ userId: 'u1', idpUserId: 'idp1' }], {
      visitorRow: () => null,
    });
    expect(await t.service.sweep()).toBe(0);
    expect(t.calls).not.toContain('idp idp1');
  });

  it('keeps everything when the provider fails, and goes on with the next', async () => {
    const t = build([
      { userId: 'u1', idpUserId: 'down' },
      { userId: 'u2', idpUserId: 'idp2' },
    ]);
    expect(await t.service.sweep()).toBe(1);
    expect(t.calls).not.toContain('users {"id":"u1","kind":"visitor"}');
    expect(t.calls).not.toContain('project u1');
    expect(t.calls).toContain('users {"id":"u2","kind":"visitor"}');
  });
});
