import { activityReach } from './agent-activity.reach';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import { PolicyEngine } from '../../iam/interfaces/policy-engine.interface';

/**
 * The one property this file exists for: **the register does not inherit the
 * administrator bypass through a scoped credential.**
 *
 * A Flui key is issued *as* its principal and carries that principal's
 * `isAdmin`, so `resolveAccess` answers "yes" to everything for an agent key an
 * administrator minted. Asking IAM before the ceiling would therefore hand the
 * whole instance's register — every call every other person's agents made — to
 * a key scoped `mcp:app:read`. The order is the control.
 */
const engine = (can: boolean): PolicyEngine =>
  ({
    resolveAccess: jest.fn().mockResolvedValue({ isAdmin: can }),
    can: jest.fn().mockReturnValue(can),
  }) as unknown as PolicyEngine;

const caller = (over: Partial<AuthenticatedUser> = {}): AuthenticatedUser =>
  ({
    userId: 'u-1',
    email: 'a@b.c',
    isAdmin: false,
    ...over,
  }) as AuthenticatedUser;

describe('how far into the register a caller sees', () => {
  it('gives the instance to whoever administers access', async () => {
    const policy = engine(true);
    await expect(activityReach(policy, caller())).resolves.toBe('instance');
    expect(policy.can).toHaveBeenCalledWith(
      expect.anything(),
      IAM_PERMISSION.IAM_READ_ACCESS,
    );
  });

  it('gives an ordinary person their own rows and asks IAM for it', async () => {
    const policy = engine(false);
    await expect(activityReach(policy, caller())).resolves.toBe('own');
  });

  it('holds an agent key of an administrator to its own rows', async () => {
    // `can` would say yes to anything: the principal behind this key is an
    // administrator. The ceiling has to answer before IAM is ever asked.
    const policy = engine(true);
    const key = caller({ isAdmin: true, scopes: [MCP_SCOPE.APP_READ] });
    await expect(activityReach(policy, key)).resolves.toBe('own');
    expect(policy.resolveAccess).not.toHaveBeenCalled();
  });

  it('lets a key scoped to read access reach the instance', async () => {
    const policy = engine(true);
    const key = caller({ isAdmin: true, scopes: [MCP_SCOPE.IAM_READ] });
    await expect(activityReach(policy, key)).resolves.toBe('instance');
  });

  it('reads a ceiling that arrived as provider roles the same way', async () => {
    const policy = engine(true);
    const key = caller({
      isAdmin: true,
      roles: { [MCP_SCOPE.APP_READ]: {} } as never,
    });
    await expect(activityReach(policy, key)).resolves.toBe('own');
  });
});
