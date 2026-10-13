jest.mock('chalk', () => {
  const same = (text: string) => text;
  const chalk: any = new Proxy(same, { get: () => chalk });
  return { __esModule: true, default: chalk };
});

import { listUsers, userLine } from './user-list';

describe('user list', () => {
  it('asks the API for one kind, by address, when told to', async () => {
    const api = { get: jest.fn(async () => []) };
    await listUsers(api as never, { kind: 'visitor', email: 'a@b', limit: 5 });
    await listUsers(api as never);
    expect(api.get.mock.calls).toEqual([
      ['/auth/users?kind=visitor&emailContains=a%40b&limit=5'],
      ['/auth/users'],
    ]);
  });

  it('says what kind each one is, and whether it is blocked', () => {
    const line = userLine({
      id: 'idp-1',
      email: 'visitor-1@visitors.invalid',
      role: 'user',
      state: 'USER_STATE_INACTIVE',
      isSystemUser: false,
      kind: 'visitor',
    }).replace(/\s+/g, ' ');
    expect(line).toBe(' visitor-1@visitors.invalid visitor user idp-1 blocked');
    expect(
      userLine({
        id: 'p',
        email: 'a@example.com',
        role: 'admin',
        isSystemUser: false,
      }),
    ).toContain('person');
  });
});
