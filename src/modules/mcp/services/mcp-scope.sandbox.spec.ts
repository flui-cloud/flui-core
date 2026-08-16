import { McpScopeResolver } from './mcp-scope.resolver';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { IdentityRole } from '../../auth/entities/user.entity';

/**
 * The condition §10-bis attaches to Agent mode, written as a test.
 *
 * MCP tools call the platform services in process. They do not go through the
 * HTTP layer, so SandboxFenceGuard, AppAccessGuard and AppOwnershipGuard are
 * none of them in the path. Until each app-scoped tool asserts ownership by
 * itself, a guest holding any scope at all holds it over the whole instance —
 * so a guest holds none.
 */
describe('MCP scopes for a sandbox guest', () => {
  const resolver = new McpScopeResolver();

  const guest: AuthenticatedUser = {
    userId: 'guest-1',
    email: 'guest@try.flui.cloud',
    roles: {},
    role: IdentityRole.USER,
    isAdmin: false,
  };

  it('offers a guest no tools at all', () => {
    expect(resolver.resolve(guest, true).size).toBe(0);
  });

  it('does not let an explicit grant on the credential reopen it', () => {
    const withScopes = { ...guest, scopes: ['mcp:read', 'mcp:write'] };
    expect(resolver.resolve(withScopes, true).size).toBe(0);
  });

  it('does not let an identity-provider role reopen it', () => {
    const withRoles = { ...guest, roles: { 'mcp:destructive': {} } };
    expect(resolver.resolve(withRoles, true).size).toBe(0);
  });

  // The escalation that would matter most: a guest whose account somehow carries
  // the admin flag must still be stopped by the sandbox binding it holds.
  it('outranks the admin shortcut', () => {
    expect(resolver.resolve({ ...guest, isAdmin: true }, true).size).toBe(0);
  });

  it('leaves everyone else exactly as they were', () => {
    expect(resolver.resolve(guest).size).toBeGreaterThan(0);
    expect(resolver.resolve({ ...guest, isAdmin: true }).size).toBeGreaterThan(
      resolver.resolve(guest).size,
    );
  });
});
