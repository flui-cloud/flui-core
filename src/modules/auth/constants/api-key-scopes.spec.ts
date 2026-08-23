import {
  GRANTABLE_SCOPES,
  SCOPE_AUTHORITY,
  SCOPE_REQUIRES_PERMISSION,
} from './api-key-scopes';
import {
  ALL_PERMISSIONS,
  IAM_PERMISSION,
} from '../../iam/constants/iam-permissions';
import { MCP_SCOPE, SCOPE_TIER } from '../../mcp/constants/mcp-scopes';

/**
 * The two columns say different things, and the point of the table is that
 * neither can quietly become the other again.
 */
describe('SCOPE_AUTHORITY', () => {
  it('answers for every grantable scope', () => {
    expect(Object.keys(SCOPE_AUTHORITY).sort()).toEqual(
      Object.values(MCP_SCOPE).sort(),
    );
    expect(GRANTABLE_SCOPES).toHaveLength(Object.values(MCP_SCOPE).length);
  });

  it('names only real IAM permissions on both sides', () => {
    for (const [scope, a] of Object.entries(SCOPE_AUTHORITY)) {
      expect(ALL_PERMISSIONS).toContain(a.requires);
      expect(a.allows.length).toBeGreaterThan(0);
      for (const p of a.allows) {
        expect({ scope, p }).toEqual({ scope, p: expect.any(String) });
        expect(ALL_PERMISSIONS).toContain(p);
      }
    }
  });

  it('keeps the minting table an exact projection, never a second copy', () => {
    for (const scope of GRANTABLE_SCOPES) {
      expect(SCOPE_REQUIRES_PERMISSION[scope]).toBe(
        SCOPE_AUTHORITY[scope].requires,
      );
    }
  });

  /**
   * The rule that stops the inversion creeping back: `requires` pins mail and
   * backup reads to `cluster:manage` because of the section they are shown in,
   * and a read scope that inherited that pin would carry the manage.
   */
  it('never lets a read scope carry a write permission', () => {
    const WRITES: string[] = [
      IAM_PERMISSION.APP_WRITE,
      IAM_PERMISSION.APP_CREATE,
      IAM_PERMISSION.APP_DEPLOY,
      IAM_PERMISSION.APP_DELETE,
      IAM_PERMISSION.SCALE_EXECUTE,
      IAM_PERMISSION.MIGRATION_EXECUTE,
      IAM_PERMISSION.CLUSTER_MANAGE,
      IAM_PERMISSION.CLUSTER_DESTROY,
      IAM_PERMISSION.IAM_ASSIGN_ROLE,
      IAM_PERMISSION.IAM_MANAGE_USERS,
      IAM_PERMISSION.INTEGRATION_MANAGE,
      IAM_PERMISSION.SHOWCASE_PUBLISH,
      IAM_PERMISSION.SANDBOX_OPERATE,
    ];
    for (const scope of GRANTABLE_SCOPES) {
      if (SCOPE_TIER[scope] !== 'read' && SCOPE_TIER[scope] !== 'plan')
        continue;
      for (const p of SCOPE_AUTHORITY[scope].allows) {
        expect({ scope, p }).toEqual({
          scope,
          p: expect.not.stringMatching(
            new RegExp(
              `^(${WRITES.map((w) => w.replace(':', '\\:')).join('|')})$`,
            ),
          ),
        });
      }
    }
  });

  it('no scope confers the power to destroy a cluster', () => {
    for (const scope of GRANTABLE_SCOPES) {
      expect(SCOPE_AUTHORITY[scope].allows).not.toContain(
        IAM_PERMISSION.CLUSTER_DESTROY,
      );
    }
  });
});
