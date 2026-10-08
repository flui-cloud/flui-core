jest.mock('../../mail/services/invite-mail.service', () => ({
  InviteMailService: class InviteMailService {},
}));
jest.mock('@kubernetes/client-node', () => ({}));

import { BadRequestException } from '@nestjs/common';
import { UserManagementService } from './user-management.service';

describe('UserManagementService blocking a person', () => {
  const build = (row: Record<string, unknown>, systemUser = false) => {
    const users = [{ ...row }];
    const userRepo = {
      findOne: async ({ where }: { where: Array<Record<string, string>> }) =>
        users.find((u) =>
          where.some((w) =>
            Object.entries(w).every(([k, v]) => u[k as keyof typeof u] === v),
          ),
        ) ?? null,
      update: async (_w: unknown, set: Record<string, unknown>) =>
        Object.assign(users[0], set),
    };
    const directory = {
      setActive: jest.fn(async () => undefined),
      getUser: jest.fn(async () => ({ isSystemUser: systemUser })),
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
    return { service, directory, gate, users };
  };

  const person = {
    id: '11111111-2222-4333-8444-555555555555',
    email: 'mario@example.com',
    oidcSub: 'sub-1',
    isAdmin: false,
    blockedAt: null,
  };

  it('marks the person, switches off their sign-in and ends their area', async () => {
    const { service, directory, gate } = build(person);

    const blocked = await service.block('sub-1', 'mining', 'admin-id');

    expect(blocked.blockedAt).toBeInstanceOf(Date);
    expect(blocked.blockedReason).toBe('mining');
    expect(directory.setActive).toHaveBeenCalledWith('sub-1', false);
    expect(gate.releaseAreaOf).toHaveBeenCalledWith(person.id);
  });

  it('undoes it', async () => {
    const { service, directory } = build({ ...person, blockedAt: new Date() });

    const back = await service.unblock(person.id);

    expect(back.blockedAt).toBeNull();
    expect(directory.setActive).toHaveBeenCalledWith('sub-1', true);
  });

  it('refuses to block the caller or an administrator', async () => {
    await expect(
      build(person).service.block('sub-1', undefined, person.id),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      build({ ...person, isAdmin: true }).service.block(
        'sub-1',
        undefined,
        'admin-id',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('never blocks a system account, such as the one the API manages identities with', async () => {
    const { service, directory } = build(person, true);

    await expect(
      service.block('sub-1', undefined, 'admin-id'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(directory.setActive).not.toHaveBeenCalled();
  });
});
