import {
  guestGetsTheRealThing,
  isOfferedToGuest,
} from './sandbox-tool-visibility';
import { ALL_TOOLS } from '../tools/tool-registry';
import { ToolDef } from '../tools/mcp-tool.util';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import { isSandboxAllowed } from '../../sandbox/constants/sandbox-fence';
import { findSandboxStandIn } from '../../sandbox/stand-in/sandbox-stand-in';

const find = (name: string): ToolDef => {
  const tool = ALL_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return tool;
};

const offered = (name: string) => isOfferedToGuest(find(name));

/**
 * The guest's catalogue, and the claim that it is the fence's own list read
 * twice rather than a second list written beside it.
 */
describe('what a guest is offered', () => {
  describe('the two questions, asked of the same list', () => {
    it('keeps a route a guest is answered for real', () => {
      expect(guestGetsTheRealThing('POST /applications/a1/deploy')).toBe(true);
      expect(
        guestGetsTheRealThing('GET /observability/applications/a1/logs'),
      ).toBe(true);
      // Real, and shown as the read-only thing it is.
      expect(guestGetsTheRealThing('GET /infrastructure/clusters/c1')).toBe(
        true,
      );
    });

    /**
     * The listing is public and the detail is not, so the two part company —
     * and the tool a guest is offered follows the route, not the pair.
     */
    it('separates a public listing from a detail route beside it', () => {
      expect(offered('template_list')).toBe(true);
      expect(offered('template_get')).toBe(false);
    });

    it('drops a route the fence refuses', () => {
      expect(guestGetsTheRealThing('POST /repositories/import')).toBe(false);
      expect(
        guestGetsTheRealThing(
          'GET /observability/clusters/c1/apps/log-sources',
        ),
      ).toBe(false);
    });

    /**
     * The half that is easy to forget. These answer `200` — a person sees the
     * example label above them, a model sees a JSON body that says nothing of
     * the kind and reports backups nobody has.
     */
    it('drops a route answered from the example world, even though it succeeds', () => {
      for (const path of [
        '/backup-policies',
        '/mail/readiness',
        '/backups/status',
      ]) {
        expect(isSandboxAllowed('GET', path)).toBe(true);
        expect(findSandboxStandIn('GET', path)).toBeDefined();
        expect(guestGetsTheRealThing(`GET ${path}`)).toBe(false);
      }
    });
  });

  describe('the catalogue that comes out', () => {
    it('offers the tools a trial is for', () => {
      for (const name of [
        'app_list',
        'app_get',
        'app_status',
        'app_deploy',
        'app_scale',
        'app_restart',
        'app_install',
        'catalog_search',
        'operation_status',
        'app_logs',
        'app_traffic',
        'app_debug',
        'app_variable_request',
      ]) {
        expect(offered(name)).toBe(true);
      }
    });

    /**
     * Decision 12 said the brake after strada B would be the fence and not the
     * scope. These are that promise, exercised: both travel on `mcp:app:write`,
     * both act on the instance rather than the tenancy, and both disappear
     * because the fence says so — not because anyone listed them here.
     */
    it('drops what belongs to the instance, not to the tenancy', () => {
      expect(offered('dns_wildcard_publish')).toBe(false);
      expect(offered('github_setup')).toBe(false);
      expect(offered('github_connect')).toBe(false);
      expect(offered('repo_connect')).toBe(false);
      expect(offered('repo_list')).toBe(false);
    });

    /** Decision 50: an invented answer is worse for an agent than a refusal. */
    it('drops every tool whose route answers from the example world', () => {
      for (const name of [
        'backup_status',
        'backup_policy_list',
        'mail_readiness',
        'mail_events',
        'mail_suppressions',
      ]) {
        expect(offered(name)).toBe(false);
      }
    });

    /**
     * `app_logs` reaches two routes: the cluster-wide label search a guest may
     * not have, and its own application's, which it may. One real branch is
     * enough to offer the tool — and the per-application branch is the reason
     * decision 47 exists.
     */
    it('keeps a tool that has one branch a guest can reach', () => {
      expect(find('app_logs').routes).toContain(
        'GET /observability/applications/:id/logs',
      );
      expect(offered('app_logs')).toBe(true);
      expect(offered('log_sources')).toBe(false);
    });
  });

  /**
   * Fail-closed, for the same reason the fence stopped using a `/sandbox/**`
   * wildcard: a tool added later is not offered to a guest until somebody has
   * said where it goes.
   */
  it('offers nothing it was told nothing about', () => {
    expect(
      isOfferedToGuest({
        name: 'undeclared_tool',
        description: '',
        inputSchema: {},
        scope: MCP_SCOPE.APP_READ,
        run: () => Promise.resolve(null),
      }),
    ).toBe(false);
  });
});
