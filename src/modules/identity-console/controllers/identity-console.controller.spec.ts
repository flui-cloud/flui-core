jest.mock('@kubernetes/client-node', () => ({}));

import 'reflect-metadata';
import { IdentityConsoleController } from './identity-console.controller';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { REQUIRED_PERMISSION_KEY } from '../../iam/decorators/require-permission.decorator';
import { BUILTIN_ROLES, IAM_ROLE } from '../../iam/constants/iam-roles';
import { isSandboxAllowed } from '../../sandbox/constants/sandbox-fence';
import { SCOPE_AUTHORITY } from '../../auth/constants/api-key-scopes';

function permissionOf(handler: keyof IdentityConsoleController): unknown {
  return Reflect.getMetadata(
    REQUIRED_PERMISSION_KEY,
    IdentityConsoleController.prototype[handler],
  );
}

describe('who reaches the identity console routes', () => {
  it('reads with iam:read-access and opens or closes with iam:manage-users', () => {
    expect(permissionOf('status')).toBe(IAM_PERMISSION.IAM_READ_ACCESS);
    expect(permissionOf('open')).toBe(IAM_PERMISSION.IAM_MANAGE_USERS);
    expect(permissionOf('close')).toBe(IAM_PERMISSION.IAM_MANAGE_USERS);
  });

  it('gives opening and closing to the owner only', () => {
    const holders = Object.values(BUILTIN_ROLES)
      .filter((r) =>
        (r.permissions as string[]).includes(IAM_PERMISSION.IAM_MANAGE_USERS),
      )
      .map((r) => r.key);
    expect(holders).toEqual([IAM_ROLE.OWNER]);
  });

  it.each([
    IAM_ROLE.SANDBOX,
    IAM_ROLE.SANDBOX_VISITOR,
    IAM_ROLE.SHOWCASE_VIEWER,
  ])('gives %s neither the state nor the switch', (role) => {
    const permissions = BUILTIN_ROLES[role].permissions as string[];
    expect(permissions).not.toContain(IAM_PERMISSION.IAM_READ_ACCESS);
    expect(permissions).not.toContain(IAM_PERMISSION.IAM_MANAGE_USERS);
  });

  it.each([
    ['GET', '/identity/console'],
    ['POST', '/identity/console/open'],
    ['POST', '/identity/console/close'],
  ])('keeps %s %s outside the sandbox fence', (verb, route) => {
    expect(isSandboxAllowed(verb, route, true)).toBe(false);
  });

  it('lets no agent scope carry the switch', () => {
    for (const [scope, authority] of Object.entries(SCOPE_AUTHORITY)) {
      expect({
        scope,
        opens: (authority.allows as string[]).includes(
          IAM_PERMISSION.IAM_MANAGE_USERS,
        ),
      }).toEqual({ scope, opens: false });
    }
  });
});
