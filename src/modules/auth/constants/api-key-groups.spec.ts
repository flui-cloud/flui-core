import {
  DEPTH_ORDER,
  PERMISSION_AREA,
  PERMISSION_GROUPS,
  PERMISSION_GROUP_KEYS,
  PermissionArea,
  UNGROUPED_BASELINE_SCOPES,
  expandPermissionGroups,
  findPermissionGroup,
  groupsForScopes,
  isPermissionGroup,
  ungroupedScopes,
} from './api-key-groups';
import { GRANTABLE_SCOPES } from './api-key-scopes';
import { MCP_SCOPE } from '../../mcp/constants/mcp-scopes';
import { ALL_TOOLS } from '../../mcp/tools/tool-registry';

/**
 * The taxonomy is a promise about what a person is consenting to, so the things
 * asserted here are the ways that promise could quietly stop being true: a
 * scope no group reaches, a deeper group that does not contain the shallower
 * one, a summary that has grown into a paragraph nobody reads.
 */
describe('permission groups — the taxonomy', () => {
  it('reaches every grantable scope except the pinned baseline ones, so nothing opt-in is only available by hand', () => {
    const named = new Set(PERMISSION_GROUPS.flatMap((g) => g.scopes));
    const optIn = GRANTABLE_SCOPES.filter(
      (s) => !(UNGROUPED_BASELINE_SCOPES as string[]).includes(s),
    );
    expect(named).toEqual(new Set(optIn));
  });

  it('reaches every scope the tools actually use, except the pinned baseline ones', () => {
    const named = new Set(PERMISSION_GROUPS.flatMap((g) => g.scopes));
    const used = [...new Set(ALL_TOOLS.map((t) => t.scope))].filter(
      (s) => !(UNGROUPED_BASELINE_SCOPES as string[]).includes(s),
    );
    expect(used.filter((s) => !named.has(s as never))).toEqual([]);
  });

  it('unlocks at least one tool per group', () => {
    for (const group of PERMISSION_GROUPS) {
      const tools = ALL_TOOLS.filter((t) =>
        (group.scopes as string[]).includes(t.scope),
      );
      expect({ group: group.key, tools: tools.length > 0 }).toEqual({
        group: group.key,
        tools: true,
      });
    }
  });

  /**
   * The one group a guest is meant to switch on, pinned tool by tool.
   *
   * Deliberately brittle: `mcp:app:write` already carries more than
   * "applications" — the wildcard DNS record, gateway routes, schedules and
   * repository links — and if another tool joins that scope, the sentence a
   * person reads before saying yes has to be read again. A red line here is
   * that reminder, not a failure.
   */
  /**
   * `api_key_request` joined this list deliberately, not by accident of scope.
   * The sandbox fence opens `GET /auth/api-keys` to a guest in so many words —
   * *"See which agents you have given a key to"* — alongside minting and
   * revoking, because handing a coding agent a credential of your own is part
   * of what the demonstration is for. A tool that asks a person to mint one
   * belongs on the same surface as the gesture it asks for.
   */
  it('unlocks exactly these tools for the switch a guest would turn on', () => {
    const group = findPermissionGroup('apps:change')!;
    const unlocked = ALL_TOOLS.filter((t) =>
      (group.scopes as string[]).includes(t.scope),
    ).map((t) => t.name);

    const byName = (a: string, b: string) => a.localeCompare(b);
    expect([...unlocked].sort(byName)).toEqual(
      [
        'api_key_request',
        'app_alerts',
        'app_debug',
        'app_deploy',
        'app_deploy_from_yaml',
        'app_events',
        'app_get',
        'app_install',
        'app_manifest_validate',
        'app_list',
        'app_logs',
        'app_metrics',
        'app_reconcile',
        'app_releases',
        'app_removal_preview',
        'app_restart',
        'app_rollback',
        'app_scale',
        'app_set_resources',
        'app_start',
        'app_status',
        'app_stop',
        'app_traffic',
        'app_variable_request',
        'app_variable_set',
        'app_variables',
        'catalog_get_app',
        'catalog_search',
        'cluster_list',
        'cluster_resources',
        'dns_wildcard_publish',
        'dns_wildcard_status',
        'gateway_list_routes',
        'gateway_route_add',
        'gateway_route_compiled',
        'gateway_set_policy',
        'gateway_status',
        'github_connect',
        'github_setup',
        'integration_status',
        'log_sources',
        'my_permissions',
        'operating_context_read',
        'operation_status',
        'repo_connect',
        'repo_list',
        'schedule_create',
        'schedule_list',
        'schedule_runs',
        'schedule_trigger',
        'spec_validate',
        'template_get',
        'template_list',
      ].sort(byName),
    );
  });

  it('is cumulative within an area: deeper contains shallower', () => {
    for (const area of Object.values(PERMISSION_AREA)) {
      const inArea = PERMISSION_GROUPS.filter((g) => g.area === area).sort(
        (a, b) => DEPTH_ORDER.indexOf(a.depth) - DEPTH_ORDER.indexOf(b.depth),
      );
      inArea.forEach((group, i) => {
        if (i === 0) return;
        const shallower = inArea[i - 1];
        const missing = shallower.scopes.filter(
          (s) => !group.scopes.includes(s),
        );
        expect({ group: group.key, missing }).toEqual({
          group: group.key,
          missing: [],
        });
      });
    }
  });

  it('keys can never be confused with scopes', () => {
    for (const key of PERMISSION_GROUP_KEYS) {
      expect(key.startsWith('mcp:')).toBe(false);
      expect(GRANTABLE_SCOPES).not.toContain(key);
    }
    expect(new Set(PERMISSION_GROUP_KEYS).size).toBe(
      PERMISSION_GROUP_KEYS.length,
    );
  });

  it('says each group in exactly one sentence', () => {
    for (const group of PERMISSION_GROUPS) {
      expect(group.label.length).toBeGreaterThan(0);
      const summary = group.summary.trim();
      expect(summary.endsWith('.')).toBe(true);
      // A second full stop means a second sentence, which means the switch no
      // longer reads at a glance.
      expect({
        key: group.key,
        inner: summary.slice(0, -1).includes('.'),
      }).toEqual({ key: group.key, inner: false });
    }
  });

  it('derives its key from its area and depth', () => {
    for (const group of PERMISSION_GROUPS) {
      expect(group.key).toBe(`${group.area}:${group.depth}`);
    }
  });

  it('recognises its own keys and nothing else', () => {
    expect(isPermissionGroup('apps:change')).toBe(true);
    expect(isPermissionGroup('mcp:app:write')).toBe(false);
    expect(isPermissionGroup('apps')).toBe(false);
    expect(findPermissionGroup('nope')).toBeUndefined();
  });
});

describe('expanding groups into scopes', () => {
  it('names which group asked for each scope', () => {
    const { scopes, askedBy } = expandPermissionGroups(['apps:change']);
    expect(scopes).toEqual([
      MCP_SCOPE.CATALOG_READ,
      MCP_SCOPE.APP_READ,
      MCP_SCOPE.SPEC_VALIDATE,
      MCP_SCOPE.APP_WRITE,
      // Operating includes reading the logs of what you operated.
      MCP_SCOPE.OBS_READ,
    ]);
    expect(askedBy.get(MCP_SCOPE.APP_WRITE)).toBe('apps:change');
  });

  it('attributes a shared scope to the first group that asked', () => {
    const { askedBy } = expandPermissionGroups([
      'apps:look',
      'observability:look',
    ]);
    expect(askedBy.get(MCP_SCOPE.APP_READ)).toBe('apps:look');
    expect(askedBy.get(MCP_SCOPE.OBS_READ)).toBe('observability:look');
  });

  it('ignores an unknown key rather than inventing scopes for it', () => {
    expect(expandPermissionGroups(['nope']).scopes).toEqual([]);
  });
});

describe('reading a key back as groups', () => {
  const groupScopes = (key: string) => [...findPermissionGroup(key)!.scopes];

  /**
   * Two names for one switch, and both of them true: `apps:change` carries
   * `mcp:obs:read`, so a key issued for it satisfies `observability:look` as
   * well. Groups are derived from scopes on purpose — a stored label could lie,
   * a derived one cannot — and the price of that is this second name, which
   * describes something the key can genuinely do.
   */
  it('names the group a key was issued for, and every other group it satisfies', () => {
    expect(groupsForScopes(groupScopes('apps:change'))).toEqual([
      'apps:change',
      'observability:look',
    ]);
  });

  it('reports only the deepest group held in an area', () => {
    const scopes = groupScopes('apps:destroy');
    expect(groupsForScopes(scopes)).toEqual([
      'apps:destroy',
      'observability:look',
    ]);
  });

  it('names one group per area for a key that spans several', () => {
    expect(groupsForScopes([...GRANTABLE_SCOPES])).toEqual([
      'apps:destroy',
      'observability:look',
      'backups:change',
      'migrations:destroy',
      'mail:look',
      'access:change',
      // The machine room, added when tools began to operate it. It is the
      // deepest group of an area of its own rather than a line inside
      // `apps:*` — which is the whole reason the brittle assertion above did
      // not move: a key issued to deploy applications is not thereby a key
      // that can stop the cluster they run on.
      'infrastructure:destroy',
    ]);
  });

  it('claims no group for a key that carries only part of one', () => {
    expect(groupsForScopes([MCP_SCOPE.APP_WRITE])).toEqual([]);
    expect(ungroupedScopes([MCP_SCOPE.APP_WRITE])).toEqual([
      MCP_SCOPE.APP_WRITE,
    ]);
  });

  it('reports the leftovers of a hand-assembled key rather than hiding them', () => {
    const scopes = [...groupScopes('apps:look'), MCP_SCOPE.BACKUP_WRITE];
    expect(groupsForScopes(scopes)).toEqual(['apps:look']);
    expect(ungroupedScopes(scopes)).toEqual([MCP_SCOPE.BACKUP_WRITE]);
  });

  it('leaves nothing ungrouped when the key matches its groups', () => {
    for (const key of PERMISSION_GROUP_KEYS) {
      expect({ key, left: ungroupedScopes(groupScopes(key)) }).toEqual({
        key,
        left: [],
      });
    }
  });

  it('returns areas in declaration order, so a panel never reshuffles', () => {
    const areas = groupsForScopes([...GRANTABLE_SCOPES]).map(
      (k) => findPermissionGroup(k)!.area as PermissionArea,
    );
    expect(areas).toEqual(Object.values(PERMISSION_AREA));
  });
});
