import { Repository } from 'typeorm';

// Same reason as the sibling spec: the real invite mailer drags in an ESM-only
// Kubernetes client Jest cannot parse. Only the DI token is needed.
jest.mock('../../mail/services/invite-mail.service', () => ({
  InviteMailService: class InviteMailService {},
}));

import { UserManagementService } from './user-management.service';
import { IdentityRole, UserEntity } from '../entities/user.entity';
import {
  IIdentityDirectory,
  IdentityUser,
} from '../interfaces/identity-directory.interface';
import { InviteMailService } from '../../mail/services/invite-mail.service';
import { ApiKeyService } from './api-key.service';

const CALLER = '11111111-1111-4111-8111-111111111111';

/**
 * Deleting a person used to be one line — remove them upstream — and every
 * trace of what they could reach stayed behind.
 *
 * The binding is the one that matters. A dead API key authenticates nobody
 * (`ApiKeyStrategy` refuses a key whose owner is gone); a surviving role
 * binding names a person by *email*, so it is a permission with no holder, and
 * it becomes somebody else's the moment that address is invited again.
 */
describe('deleting a person, and what Flui still knew about them', () => {
  const target: IdentityUser = {
    id: 'target-oidc-sub',
    email: 'gone@example.test',
    role: IdentityRole.USER,
    isBootstrapAdmin: false,
    isSystemUser: false,
  };

  const local = {
    id: 'local-uuid',
    email: 'gone@example.test',
    oidcSub: 'target-oidc-sub',
  } as UserEntity;

  function build() {
    const directory = {
      getUser: jest.fn().mockResolvedValue(target),
      deleteUser: jest.fn().mockResolvedValue(undefined),
    };
    const userRepo = {
      findOne: jest
        .fn()
        // first call: the caller's own row (guard against self-deletion)
        .mockResolvedValueOnce({ id: CALLER, oidcSub: 'caller-sub' })
        // second call: the local row of whoever is being deleted
        .mockResolvedValueOnce(local),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    } as unknown as Repository<UserEntity>;
    const bindings = {
      delete: jest.fn().mockResolvedValue({ affected: 2 }),
    };
    const groups = {
      find: jest.fn().mockResolvedValue([
        {
          name: 'platform',
          members: ['gone@example.test', 'stays@example.test'],
        },
        { name: 'other', members: ['stays@example.test'] },
      ]),
      save: jest.fn().mockImplementation((g) => Promise.resolve(g)),
    };
    const apiKeys = {
      revokeAllForUser: jest.fn().mockResolvedValue(3),
    } as unknown as jest.Mocked<Pick<ApiKeyService, 'revokeAllForUser'>>;

    const service = new UserManagementService(
      directory as unknown as IIdentityDirectory,
      userRepo,
      bindings as never,
      groups as never,
      apiKeys as never,
      {} as InviteMailService,
    );
    return { service, directory, userRepo, bindings, groups, apiKeys };
  }

  it('revokes the keys instead of deleting them', async () => {
    const { service, apiKeys } = build();
    await service.deleteUser('target-oidc-sub', CALLER);
    expect(apiKeys.revokeAllForUser).toHaveBeenCalledWith('local-uuid');
  });

  /**
   * Both addressings, because a person is named two ways: `user` by email, and
   * `service_account` by their local id. Cleaning only the first leaves the
   * second — which was the shape the sandbox reaper had, until it stopped
   * writing its own cleanup and started calling this one.
   */
  it('removes every role binding that named them, by either name', async () => {
    const { service, bindings } = build();
    await service.deleteUser('target-oidc-sub', CALLER);

    expect(bindings.delete).toHaveBeenCalledWith({
      principalType: 'user',
      principalRef: 'gone@example.test',
    });
    expect(bindings.delete).toHaveBeenCalledWith({
      principalType: 'service_account',
      principalRef: 'local-uuid',
    });
  });

  it('takes them out of the groups that would have re-granted it all', async () => {
    const { service, groups } = build();
    await service.deleteUser('target-oidc-sub', CALLER);

    expect(groups.save).toHaveBeenCalledTimes(1);
    expect(groups.save).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'platform',
        members: ['stays@example.test'],
      }),
    );
  });

  /**
   * The local row stays. Every application, repository and backup the person
   * created points at it, and deleting a person must not delete their work —
   * the sandbox reaper may delete its row only because it destroys the
   * tenancy's applications first. What goes is the link to an account that no
   * longer exists.
   */
  it('keeps the local row and severs its link to the deleted account', async () => {
    const { service, userRepo } = build();
    await service.deleteUser('target-oidc-sub', CALLER);

    expect(userRepo.delete).toBeUndefined();
    expect(userRepo.update).toHaveBeenCalledWith(
      { id: 'local-uuid' },
      { oidcSub: null },
    );
  });

  /**
   * The reaper calls this method directly, with a tenancy whose local id may
   * already be gone. An undefined criterion is not a narrower delete, it is a
   * delete of every binding on the installation.
   */
  it('never asks for a binding by an id it does not have', async () => {
    const { service, bindings } = build();
    await service.detachRoleBindings({ id: null, email: 'gone@example.test' });

    expect(bindings.delete).toHaveBeenCalledTimes(1);
    expect(bindings.delete).toHaveBeenCalledWith({
      principalType: 'user',
      principalRef: 'gone@example.test',
    });
  });

  it('removes the grants written to the person by id as well as by email', async () => {
    const { service, bindings } = build();
    await service.detachRoleBindings({
      id: 'local-uuid',
      email: 'p@example.test',
    });

    expect(bindings.delete).toHaveBeenCalledWith({
      principalType: 'user',
      principalRef: 'p@example.test',
    });
    expect(bindings.delete).toHaveBeenCalledWith({
      principalType: 'user',
      principalRef: 'local-uuid',
    });
    expect(bindings.delete).toHaveBeenCalledWith({
      principalType: 'service_account',
      principalRef: 'local-uuid',
    });
  });

  it('does the upstream deletion first, so nothing local is lost to a failure there', async () => {
    const { service, directory, apiKeys } = build();
    directory.deleteUser.mockRejectedValueOnce(new Error('idp unreachable'));

    await expect(service.deleteUser('target-oidc-sub', CALLER)).rejects.toThrow(
      'idp unreachable',
    );
    expect(apiKeys.revokeAllForUser).not.toHaveBeenCalled();
  });

  it('lets a service credential delete a person, without reading it as a person id', async () => {
    const { service, directory, userRepo } = build();
    (userRepo.findOne as jest.Mock).mockReset().mockResolvedValueOnce(local);

    await service.deleteUser('target-oidc-sub', 'cli-service-account');

    expect(directory.deleteUser).toHaveBeenCalledWith('target-oidc-sub');
  });

  it("finds the person by the identity provider's own id, never reading it as a local one", async () => {
    const { service, userRepo, bindings } = build();

    await service.deleteUser('394212883803668667', CALLER);

    expect((userRepo.findOne as jest.Mock).mock.calls[1][0]).toEqual({
      where: { oidcSub: '394212883803668667' },
    });
    expect(bindings.delete).toHaveBeenCalled();
  });
});
