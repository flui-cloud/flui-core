import { NotFoundException } from '@nestjs/common';
import { REQUIRED_PERMISSION_KEY } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { BUILTIN_ROLES, IAM_ROLE } from '../../iam/constants/iam-roles';
import { ACTION_CYCLE_KEY } from '../../action-cycle/action-cycle.decorator';
import { isSandboxAllowed } from '../../sandbox/constants/sandbox-fence';
import { SCOPE_AUTHORITY } from '../constants/api-key-scopes';
import { SandboxSignInController } from './sandbox-sign-in.controller';

const handler = (name: keyof SandboxSignInController) =>
  SandboxSignInController.prototype[name] as unknown as object;

const permissionOf = (name: keyof SandboxSignInController) =>
  Reflect.getMetadata(REQUIRED_PERMISSION_KEY, handler(name)) as string;

describe('SandboxSignInController', () => {
  describe('who reaches it', () => {
    it('asks sandbox:operate to connect or disconnect, and cluster:read to look', () => {
      expect(permissionOf('connect')).toBe(IAM_PERMISSION.SANDBOX_OPERATE);
      expect(permissionOf('disconnect')).toBe(IAM_PERMISSION.SANDBOX_OPERATE);
      expect(permissionOf('list')).toBe(IAM_PERMISSION.CLUSTER_READ);
    });

    it('is closed to a guest, by the fence and by the role', () => {
      for (const [verb, path] of [
        ['GET', '/sandbox/sign-in/providers'],
        ['PUT', '/sandbox/sign-in/providers/github'],
        ['DELETE', '/sandbox/sign-in/providers/google'],
      ]) {
        expect(isSandboxAllowed(verb, path)).toBe(false);
      }
      const guest = BUILTIN_ROLES[IAM_ROLE.SANDBOX].permissions as string[];
      expect(guest).not.toContain(IAM_PERMISSION.SANDBOX_OPERATE);
      expect(guest).not.toContain(IAM_PERMISSION.CLUSTER_READ);
    });

    it('lets no agent scope write it', () => {
      for (const authority of Object.values(SCOPE_AUTHORITY)) {
        expect(authority.allows).not.toContain(IAM_PERMISSION.SANDBOX_OPERATE);
      }
    });

    it('asks a person before an agent takes a provider away', () => {
      expect(
        Reflect.getMetadata(ACTION_CYCLE_KEY, handler('disconnect')),
      ).toMatchObject({
        action: 'DELETE /sandbox/sign-in/providers/:provider',
        bind: ['provider'],
      });
    });
  });

  describe('what it passes on', () => {
    const build = () => {
      const service = {
        list: jest.fn().mockResolvedValue({ providers: [] }),
        connect: jest.fn().mockResolvedValue({ provider: 'github' }),
        disconnect: jest.fn().mockResolvedValue({ provider: 'google' }),
      };
      return {
        service,
        controller: new SandboxSignInController(service as never),
      };
    };
    const req = { user: { userId: 'u1', email: 'admin@flui.cloud' } as never };

    it('hands the credentials and who asked to the service', async () => {
      const { service, controller } = build();

      await controller.connect(
        'github',
        { clientId: 'id', clientSecret: 'secret' },
        req,
      );

      expect(service.connect).toHaveBeenCalledWith(
        'github',
        { clientId: 'id', clientSecret: 'secret' },
        'admin@flui.cloud',
      );
    });

    it('answers 404 for a provider it does not offer, before reaching the service', () => {
      const { service, controller } = build();

      expect(() =>
        controller.connect(
          'gitlab',
          { clientId: 'id', clientSecret: 'secret' },
          req,
        ),
      ).toThrow(NotFoundException);
      expect(() => controller.disconnect('gitlab', req)).toThrow(
        NotFoundException,
      );
      expect(service.connect).not.toHaveBeenCalled();
      expect(service.disconnect).not.toHaveBeenCalled();
    });

    it('disconnects in the name of who asked', async () => {
      const { service, controller } = build();

      await controller.disconnect('google', req);

      expect(service.disconnect).toHaveBeenCalledWith(
        'google',
        'admin@flui.cloud',
      );
    });
  });
});
