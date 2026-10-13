import { REQUIRED_PERMISSION_KEY } from '../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../iam/constants/iam-permissions';
import { BUILTIN_ROLES, IAM_ROLE } from '../iam/constants/iam-roles';
import { SCOPE_AUTHORITY } from '../auth/constants/api-key-scopes';
import { SandboxVisitorStatsController } from './sandbox-visitor-stats.controller';

describe('SandboxVisitorStatsController', () => {
  it('asks sandbox:operate', () => {
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSION_KEY,
        SandboxVisitorStatsController.prototype.get,
      ),
    ).toBe(IAM_PERMISSION.SANDBOX_OPERATE);
  });

  it('is closed to guests and visitors, and to every agent scope', () => {
    for (const role of [IAM_ROLE.SANDBOX, IAM_ROLE.SANDBOX_VISITOR]) {
      expect(BUILTIN_ROLES[role].permissions as string[]).not.toContain(
        IAM_PERMISSION.SANDBOX_OPERATE,
      );
    }
    for (const authority of Object.values(SCOPE_AUTHORITY)) {
      expect(authority.allows).not.toContain(IAM_PERMISSION.SANDBOX_OPERATE);
    }
  });

  it('answers with the stats service', async () => {
    const stats = { stats: jest.fn(async () => ({ inside: 3 })) };
    const controller = new SandboxVisitorStatsController(stats as never);
    await expect(controller.get()).resolves.toEqual({ inside: 3 });
  });
});
