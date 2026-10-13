jest.mock('../../mail/services/invite-mail.service', () => ({
  InviteMailService: class InviteMailService {},
}));
jest.mock('@kubernetes/client-node', () => ({}));

import { UserManagementService } from './user-management.service';

describe('UserManagementService and the demo’s visitors', () => {
  const visitor = {
    id: '11111111-2222-4333-8444-555555555555',
    email: 'visitor-ab12cd34@visitors.invalid',
    oidcSub: 'idp-v1',
    displayName: 'Visitor',
    role: 'user',
    kind: 'visitor',
    isAdmin: false,
    blockedAt: null as Date | null,
  };

  const build = () => {
    const rows = [{ ...visitor }];
    const userRepo = {
      findOne: async ({ where }: { where: Array<Record<string, string>> }) =>
        rows.find((u) =>
          where.some((w) =>
            Object.entries(w).every(([k, v]) => u[k as keyof typeof u] === v),
          ),
        ) ?? null,
      update: async (_w: unknown, set: Record<string, unknown>) =>
        Object.assign(rows[0], set),
      find: jest.fn(async () => rows),
    };
    const directory = {
      setActive: jest.fn(async () => undefined),
      getUser: jest.fn(async () => ({ isSystemUser: false })),
      listUsers: jest.fn(async () => [
        { id: 'p1', email: 'a@example.com', kind: 'person' },
        {
          id: 'idp-pool',
          email: 'visitor-x@visitors.invalid',
          kind: 'visitor',
        },
      ]),
    };
    const gate = { releaseAreaOf: jest.fn(async () => undefined) };
    const service = new UserManagementService(
      directory as never,
      userRepo as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      gate as never,
    );
    return { service, directory, userRepo, rows };
  };

  it('blocks a visitor like anybody: marked here, switched off at the provider', async () => {
    const t = build();

    const blocked = await t.service.block('idp-v1', 'abuse', 'admin-id');

    expect(blocked.blockedAt).toBeInstanceOf(Date);
    expect(t.directory.setActive).toHaveBeenCalledWith('idp-v1', false);
  });

  it('lists visitors from Flui’s own rows, newest first, marked as visitors', async () => {
    const t = build();
    t.rows[0].blockedAt = new Date();

    const list = await t.service.listUsers({
      kind: 'visitor',
      limit: 10,
      emailContains: 'ab12',
    });

    expect(t.directory.listUsers).not.toHaveBeenCalled();
    expect(list).toEqual([
      expect.objectContaining({
        id: 'idp-v1',
        kind: 'visitor',
        state: 'USER_STATE_INACTIVE',
      }),
    ]);
    const options = t.userRepo.find.mock.calls[0] as unknown as [
      Record<string, unknown>,
    ];
    expect(options[0]).toMatchObject({
      order: { createdAt: 'DESC' },
      take: 10,
      skip: 0,
      where: { kind: 'visitor' },
    });
  });

  it('leaves visitors out when asked for everybody else, and keeps them in otherwise', async () => {
    const t = build();
    expect(
      (await t.service.listUsers({ kind: 'person' })).map((u) => u.id),
    ).toEqual(['p1']);
    expect((await t.service.listUsers()).map((u) => u.id)).toEqual([
      'p1',
      'idp-pool',
    ]);
    expect(t.directory.listUsers).toHaveBeenLastCalledWith({});
  });
});
