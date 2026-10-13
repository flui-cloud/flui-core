import { NotFoundException } from '@nestjs/common';
import { VisitorPoolService } from './visitor-pool.service';
import { loadVisitorConfig } from './visitor.config';
import { UserEntity } from '../../auth/entities/user.entity';
import { SandboxVisitorEntity } from '../entities/sandbox-visitor.entity';

const ENV = {
  ZITADEL_SERVICE_ACCOUNT_PAT: 'service-pat',
  OIDC_ISSUER: 'https://auth.example.test',
};

describe('VisitorPoolService', () => {
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => {
    saved = { ...process.env };
    Object.assign(process.env, ENV);
  });
  afterEach(() => {
    process.env = saved;
  });

  const build = (
    over: { ready?: number; taken?: unknown[]; sessionFails?: boolean } = {},
  ) => {
    const saved: Array<[unknown, unknown]> = [];
    const manager = {
      query: jest.fn(async (_sql: string) => [over.taken ?? [], 1]),
      getRepository: (entity: unknown) => ({
        create: (r: unknown) => r,
        save: async (r: unknown) => {
          saved.push([entity, r]);
          return entity === UserEntity ? { ...(r as object), id: 'u-1' } : r;
        },
      }),
    };
    const pool = {
      count: jest.fn(async () => over.ready ?? 0),
      insert: jest.fn(async () => undefined),
      find: jest.fn(async () => [{ id: 'old', idpUserId: 'idp-old' }]),
      delete: jest.fn(async () => ({ affected: 1 })),
    };
    const login = {
      createHuman: jest.fn(async () => 'idp-new'),
      createSession: jest.fn(async () => {
        if (over.sessionFails) throw new Error('session refused');
        return { sessionId: 's-new', sessionToken: 't-new' };
      }),
    };
    const directory = { deleteUser: jest.fn(async () => undefined) };
    const service = new VisitorPoolService(
      loadVisitorConfig({ SANDBOX_VISITOR_POOL_MIN: '3' }),
      pool as never,
      {
        transaction: async (work: (m: unknown) => unknown) => work(manager),
      } as never,
      login as never,
      { token: async () => 'login-pat' } as never,
      {
        encrypt: (v: string) => `enc(${v})`,
        decrypt: (v: string) => v.replace(/^enc\((.*)\)$/, '$1'),
      } as never,
      directory as never,
    );
    return { service, pool, login, directory, saved, manager };
  };

  it('makes the visitors that are missing, keeping only the encrypted session token', async () => {
    const t = build({ ready: 1 });
    expect(await t.service.refill()).toBe(2);
    const row = (t.pool.insert.mock.calls[0] as unknown[])[0] as Record<
      string,
      string
    >;
    expect(row).toMatchObject({
      idpUserId: 'idp-new',
      sessionId: 's-new',
      sessionTokenEncrypted: 'enc(t-new)',
    });
    const [, , human] = t.login.createHuman.mock.calls[0] as unknown as [
      string,
      string,
      Record<string, string>,
    ];
    expect(human.userName).toBe(
      `visitor-${row.id.replace(/-/g, '').slice(0, 8)}`,
    );
    expect(human.email).toBe(`${human.userName}@visitors.invalid`);
    const [pat, , , password] = t.login.createSession.mock
      .calls[0] as unknown as string[];
    expect(pat).toBe('login-pat');
    expect(password).toBe(human.password);
  });

  it('does nothing when the pool is full', async () => {
    const t = build({ ready: 3 });
    expect(await t.service.refill()).toBe(0);
    expect(t.login.createHuman).not.toHaveBeenCalled();
  });

  it('removes the account when its session cannot be opened', async () => {
    const t = build({ sessionFails: true });
    await expect(t.service.make()).rejects.toThrow('session refused');
    expect(t.directory.deleteUser).toHaveBeenCalledWith('idp-new');
  });

  it('hands out a ready visitor and writes its local rows in the same transaction', async () => {
    const t = build({
      taken: [
        {
          id: 'abcdef12-0000-0000-0000-000000000000',
          idpUserId: 'idp-1',
          sessionId: 's1',
          token: 'enc(t1)',
        },
      ],
    });
    expect(await t.service.enter('iphash')).toEqual({
      userId: 'u-1',
      session: { sessionId: 's1', sessionToken: 't1' },
      fromPool: true,
    });
    const sql = String(t.manager.query.mock.calls[0][0]);
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain('DELETE FROM "sandbox_visitor_pool"');
    expect(sql).not.toContain('UPDATE "sandbox_visitor_pool"');
    const user = t.saved.find(([e]) => e === UserEntity)![1];
    expect(user).toMatchObject({
      kind: 'visitor',
      oidcSub: 'idp-1',
      email: 'visitor-abcdef12@visitors.invalid',
    });
    expect(t.saved.find(([e]) => e === SandboxVisitorEntity)![1]).toEqual({
      userId: 'u-1',
      idpUserId: 'idp-1',
      ipHash: 'iphash',
    });
    expect(t.login.createHuman).not.toHaveBeenCalled();
  });

  it('makes a visitor on the spot when none is ready', async () => {
    const t = build({ taken: [] });
    const entered = await t.service.enter('iphash');
    expect(entered).toMatchObject({
      userId: 'u-1',
      fromPool: false,
      session: { sessionId: 's-new' },
    });
  });

  it('recycles visitors nobody took, already gone at the provider or not', async () => {
    const t = build();
    t.directory.deleteUser.mockRejectedValueOnce(new NotFoundException());
    expect(await t.service.recycle()).toBe(1);
    expect(t.directory.deleteUser).toHaveBeenCalledWith('idp-old');
    expect(t.pool.delete).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(t.pool.delete.mock.calls[1])).toContain('takenAt');
  });

  it('says how many it made even when a later one fails', async () => {
    const t = build({ ready: 0 });
    const log = jest
      .spyOn(
        (t.service as unknown as { logger: { log: () => void } }).logger,
        'log',
      )
      .mockImplementation(() => undefined);
    t.login.createHuman
      .mockResolvedValueOnce('idp-a')
      .mockRejectedValueOnce(new Error('provider down'));
    await expect(t.service.refill()).rejects.toThrow('provider down');
    expect(log).toHaveBeenCalledWith('Made 1 visitor(s) ahead of time');
  });
});
