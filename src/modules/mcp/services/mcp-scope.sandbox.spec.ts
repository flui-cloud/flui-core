import { McpScopeResolver } from './mcp-scope.resolver';
import { isOfferedToGuest } from './sandbox-tool-visibility';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { IdentityRole } from '../../auth/entities/user.entity';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import { findPermissionGroup } from '../../auth/constants/api-key-groups';
import { ALL_TOOLS } from '../tools/tool-registry';
import { isExecutable, McpToolContext } from '../tools/mcp-tool.util';

/**
 * What a sandbox guest's agent is handed, and what still holds it back.
 *
 * The condition §10-bis attached to Agent mode was that a guest gets nothing at
 * all, and the reason was written into the resolver: the tools called the
 * platform services in process, so SandboxFenceGuard, AppAccessGuard and
 * AppOwnershipGuard were none of them in the path, and one scope was the whole
 * instance. Strada B removed that premise — every tool now calls the API over
 * HTTP as the caller — so the condition is met and the door opens.
 *
 * What replaces "nothing at all" is two things, and this file pins both: a
 * default of `apps:change` and no more, and a catalogue trimmed to the routes
 * the fence would actually answer with the real thing.
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

  const appsChange = findPermissionGroup('apps:change')!.scopes;

  it('defaults a guest to the group a person is shown when connecting an agent', () => {
    const byName = (a: string, b: string) => a.localeCompare(b);
    expect([...resolver.resolve(guest, true)].sort(byName)).toEqual(
      [...appsChange].sort(byName),
    );
  });

  /**
   * Not the platform default, which spans backups, migrations and mail — the
   * three areas a guest is shown an example of. Offering their tools would be
   * offering a model invented data.
   */
  it('is narrower than the default every other principal gets', () => {
    expect(resolver.resolve(guest, true).size).toBeLessThan(
      resolver.resolve(guest).size,
    );
    expect(resolver.resolve(guest, true).has(MCP_SCOPE.BACKUP_READ)).toBe(
      false,
    );
    expect(resolver.resolve(guest, true).has(MCP_SCOPE.MAIL_READ)).toBe(false);
  });

  /**
   * A credential that names its own scopes still wins, as for everybody else,
   * and that is the point of the consent screen rather than a hole in it: a
   * guest may only ever mint a key carrying scopes whose permission it already
   * holds (`api-key-scopes.ts`), which for a guest is its own applications.
   * Reading its own logs is the case this exists for — decision 47.
   */
  it('lets the credential the guest itself minted decide', () => {
    const withObs = {
      ...guest,
      scopes: [...appsChange, MCP_SCOPE.OBS_READ] as string[],
    };
    expect(resolver.resolve(withObs, true).has(MCP_SCOPE.OBS_READ)).toBe(true);
  });

  /** The admin shortcut is not a door out of the sandbox. */
  it('does not hand a guest the destructive tier through the admin flag', () => {
    const scopes = resolver.resolve({ ...guest, isAdmin: true }, true);
    expect(scopes.has(MCP_SCOPE.APP_DESTRUCTIVE)).toBe(false);
    expect(scopes.has(MCP_SCOPE.BACKUP_WRITE)).toBe(false);
  });

  it('leaves everyone else exactly as they were', () => {
    expect(resolver.resolve(guest).size).toBeGreaterThan(0);
    expect(resolver.resolve({ ...guest, isAdmin: true }).size).toBeGreaterThan(
      resolver.resolve(guest).size,
    );
  });

  /**
   * The sentinel that replaces "a guest gets nothing": whatever a guest's
   * credential ends up saying — including an identity-provider role that
   * injected `mcp:*` keys — the catalogue it is offered contains no tool whose
   * route the fence refuses or answers from the example world.
   *
   * This is the invariant the old empty set was standing in for, said in terms
   * of the thing that actually decides.
   */
  it('offers no tool the fence would refuse or invent an answer for, whatever the credential says', () => {
    const everything = {
      ...guest,
      scopes: Object.values(MCP_SCOPE) as string[],
      roles: { 'mcp:app:destructive': {} },
    };
    const scopes = resolver.resolve(everything, true);
    const ctx = { scopes, allowDestructive: true } as McpToolContext;

    const offered = ALL_TOOLS.filter(
      (t) => isExecutable(ctx, t) && isOfferedToGuest(t),
    ).map((t) => t.name);

    for (const closed of [
      'dns_wildcard_publish',
      'github_setup',
      'github_connect',
      'repo_connect',
      'repo_list',
      'log_sources',
      'migrate_app',
      'backup_run',
    ]) {
      expect(offered).not.toContain(closed);
    }
    for (const invented of [
      'backup_status',
      'backup_policy_list',
      'mail_readiness',
      'mail_events',
      'mail_suppressions',
    ]) {
      expect(offered).not.toContain(invented);
    }
  });
});
