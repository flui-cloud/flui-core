import { ConflictException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Repository } from 'typeorm';

// Importing the real invite mailer drags in the credential chain and, through
// it, an ESM-only Kubernetes client Jest cannot parse. Only the DI token is
// needed here.
jest.mock('../../mail/services/invite-mail.service', () => ({
  InviteMailService: class InviteMailService {},
}));

import { UserManagementService } from './user-management.service';
import { UpdateIdentityRoleDto } from '../dto/update-identity-role.dto';
import { ASSIGNABLE_IDENTITY_ROLES } from '../constants/assignable-roles';
import { IdentityRole, UserEntity } from '../entities/user.entity';
import {
  IIdentityDirectory,
  IdentityUser,
} from '../interfaces/identity-directory.interface';
import { InviteMailService } from '../../mail/services/invite-mail.service';

/**
 * `PATCH /auth/users/:id/role` runs on `iam:assign-role`, which the built-in
 * `maintainer` role holds. So the whole safety of the route is that the value
 * `admin` cannot travel through it — proven here at the wire (the DTO) and
 * restated by the type the service accepts.
 */
describe('setRole — the route cannot confer platform admin', () => {
  async function validateRole(role: unknown): Promise<string[]> {
    const dto = plainToInstance(UpdateIdentityRoleDto, { role });
    const errors = await validate(dto);
    return errors.flatMap((e) => Object.values(e.constraints ?? {}));
  }

  it('rejects admin at the wire, and says why', async () => {
    const messages = await validateRole(IdentityRole.ADMIN);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('platform admin cannot be conferred');
  });

  it.each(ASSIGNABLE_IDENTITY_ROLES)('accepts %s', async (role) => {
    await expect(validateRole(role)).resolves.toEqual([]);
  });

  it('rejects an unknown role', async () => {
    await expect(validateRole('owner')).resolves.toHaveLength(1);
  });

  it('never advertises admin in the accepted set', () => {
    expect(ASSIGNABLE_IDENTITY_ROLES).not.toContain(IdentityRole.ADMIN);
  });
});

describe('UserManagementService.setRole', () => {
  const target: IdentityUser = {
    id: 'target-oidc-sub',
    email: 'target@example.test',
    role: IdentityRole.USER,
    isBootstrapAdmin: false,
    isSystemUser: false,
  };

  function build(caller: Partial<UserEntity> | null) {
    const directory: jest.Mocked<
      Pick<IIdentityDirectory, 'getUser' | 'setRole'>
    > = {
      getUser: jest.fn().mockResolvedValue(target),
      setRole: jest.fn().mockResolvedValue(undefined),
    };
    const userRepo = {
      findOne: jest.fn().mockResolvedValue(caller),
    } as unknown as Repository<UserEntity>;
    const service = new UserManagementService(
      directory as unknown as IIdentityDirectory,
      userRepo,
      {} as never,
      {} as never,
      {} as never,
      {} as InviteMailService,
    );
    return { service, directory };
  }

  it('delegates an assignable role to the directory', async () => {
    const { service, directory } = build({
      id: 'caller',
      oidcSub: 'caller-sub',
    });
    await service.setRole('target-oidc-sub', IdentityRole.READONLY, 'caller');
    expect(directory.setRole).toHaveBeenCalledWith(
      'target-oidc-sub',
      IdentityRole.READONLY,
    );
  });

  it('404s on an unknown user before touching the directory', async () => {
    const { service, directory } = build({ id: 'caller' });
    directory.getUser.mockResolvedValue(null);
    await expect(
      service.setRole('ghost', IdentityRole.USER, 'caller'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(directory.setRole).not.toHaveBeenCalled();
  });

  it('refuses a caller changing its own role, by local id', async () => {
    const { service, directory } = build({ id: 'target-oidc-sub' });
    await expect(
      service.setRole('target-oidc-sub', IdentityRole.READONLY, 'caller'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(directory.setRole).not.toHaveBeenCalled();
  });

  it('refuses a caller changing its own role, by oidc subject', async () => {
    const { service, directory } = build({
      id: 'caller',
      oidcSub: 'target-oidc-sub',
    });
    await expect(
      service.setRole('target-oidc-sub', IdentityRole.USER, 'caller'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(directory.setRole).not.toHaveBeenCalled();
  });
});
