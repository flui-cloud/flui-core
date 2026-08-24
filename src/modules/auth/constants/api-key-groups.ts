import { MCP_SCOPE, McpScope } from '../../mcp/constants/mcp-scopes';

/**
 * The unit of consent: what a person switches on when they connect an agent.
 *
 * Not a second authorization system. IAM stays the authority and every scope a
 * group names is still checked one at a time against the ceiling in
 * `api-key-scopes.ts` — a group decides only what gets *asked for*, in one
 * gesture instead of twelve. Nobody administers an agent by ticking twelve
 * boxes, and a long flat list is granted whole out of fatigue, which is how
 * least privilege dies.
 *
 * Two dimensions, because the tier model (read → plan → write → destructive) is
 * only one of them: it says how deep, never over what.
 *   - AREA  — what the agent is being trusted with;
 *   - DEPTH — how far into that area it may go.
 *
 * A group is refused whole or granted whole. It never comes back smaller than
 * asked for, so what a person consented to and what the credential carries are
 * the same sentence.
 */

export const PERMISSION_AREA = {
  APPS: 'apps',
  OBSERVABILITY: 'observability',
  BACKUPS: 'backups',
  MIGRATIONS: 'migrations',
  MAIL: 'mail',
  ACCESS: 'access',
} as const;

export type PermissionArea =
  (typeof PERMISSION_AREA)[keyof typeof PERMISSION_AREA];

export const PERMISSION_DEPTH = {
  LOOK: 'look',
  CHANGE: 'change',
  DESTROY: 'destroy',
} as const;

export type PermissionDepth =
  (typeof PERMISSION_DEPTH)[keyof typeof PERMISSION_DEPTH];

/** Shallow to deep. Within one area, a deeper group contains every shallower one. */
export const DEPTH_ORDER: PermissionDepth[] = [
  PERMISSION_DEPTH.LOOK,
  PERMISSION_DEPTH.CHANGE,
  PERMISSION_DEPTH.DESTROY,
];

export interface PermissionGroupDef {
  /** `<area>:<depth>`. Never starts with `mcp:`, so a group key and a scope can never be confused. */
  key: string;
  area: PermissionArea;
  depth: PermissionDepth;
  label: string;
  /**
   * One sentence, because it is the whole of what a person reads before saying
   * yes. If a group cannot be said in one sentence it is the wrong group.
   */
  summary: string;
  /**
   * Every scope the group carries, named in full rather than inherited, so this
   * file can be read as a declaration instead of executed as a computation.
   *
   * A group names what its own tools need in order to be *usable*, which is not
   * always only its area's scopes: `app_traffic` and `app_alerts` are addressed
   * by an application id that comes from `app_list`, and `migrate_app` takes a
   * source app and a target cluster from the same place. Leaving `mcp:app:read`
   * out of those groups would ship a switch that grants a tool nobody can call.
   */
  scopes: McpScope[];
}

/**
 * A group can only be as narrow as the scopes it names, and two of them are
 * wider than they sound.
 *
 * `mcp:app:read` also carries the clusters, repositories, templates, gateway
 * routes and DNS status; `mcp:app:write` also carries publishing the wildcard
 * DNS record, adding a gateway route, creating a schedule and connecting a
 * repository. There is no infrastructure scope for those to live in instead.
 *
 * Two consequences, both deliberate: no `infrastructure` area exists here,
 * because nothing would be left in it; and the summaries below say what the
 * scopes really carry rather than what the area is called, since a sentence
 * that under-promises is the one way this file could mislead the person
 * reading it. Narrowing them means splitting the scope catalogue, which is not
 * this file's to split.
 */
const APPS_LOOK: McpScope[] = [
  MCP_SCOPE.CATALOG_READ,
  MCP_SCOPE.APP_READ,
  // Validating a manifest is `plan` in the tier model, but depth here is blast
  // radius and this one has none: it reads a file and answers.
  MCP_SCOPE.SPEC_VALIDATE,
];

/**
 * Operating includes seeing what you did. An agent handed "Deploy and operate
 * applications" and nothing else deployed, watched the pod fail, and had no way
 * to read the line that said why — so the person had to switch on a second
 * group for the first group to be usable at all, which is the thing this file
 * says a group must never require.
 *
 * The cost, and it is visible: groups are derived from scopes, so a key holding
 * exactly this set now also reads as `observability:look`. That is true — it
 * can read logs — and a name for a capability the key genuinely has is the
 * right kind of surprise.
 */
const APPS_CHANGE: McpScope[] = [
  ...APPS_LOOK,
  MCP_SCOPE.APP_WRITE,
  MCP_SCOPE.OBS_READ,
];

const BACKUPS_LOOK: McpScope[] = [MCP_SCOPE.BACKUP_READ];
const MIGRATIONS_LOOK: McpScope[] = [MCP_SCOPE.MIGRATION_READ];

export const PERMISSION_GROUPS: PermissionGroupDef[] = [
  {
    key: 'apps:look',
    area: PERMISSION_AREA.APPS,
    depth: PERMISSION_DEPTH.LOOK,
    label: 'See applications',
    summary:
      'Read the applications on this instance and their history, together with the catalogue, templates, repositories and clusters behind them — and change nothing.',
    scopes: APPS_LOOK,
  },
  {
    key: 'apps:change',
    area: PERMISSION_AREA.APPS,
    depth: PERMISSION_DEPTH.CHANGE,
    label: 'Deploy and operate applications',
    summary:
      'Deploy, install, scale, restart and stop applications, set up the routes, schedules, wildcard DNS and repository links they need, read the logs, traffic and alerts of what it is running, and ask you in person for a sensitive value it must never hold itself, on top of everything See applications reads — but never delete one.',
    scopes: APPS_CHANGE,
  },
  {
    key: 'apps:destroy',
    area: PERMISSION_AREA.APPS,
    depth: PERMISSION_DEPTH.DESTROY,
    label: 'Delete applications',
    summary:
      'Everything Deploy and operate applications can do, plus deleting an application, a schedule or a gateway route for good.',
    scopes: [...APPS_CHANGE, MCP_SCOPE.APP_DESTRUCTIVE],
  },
  {
    key: 'observability:look',
    area: PERMISSION_AREA.OBSERVABILITY,
    depth: PERMISSION_DEPTH.LOOK,
    label: 'Read logs and health',
    summary:
      'Read the applications on this instance together with their logs, edge traffic and alert history, and change nothing.',
    scopes: [MCP_SCOPE.APP_READ, MCP_SCOPE.OBS_READ],
  },
  {
    key: 'backups:look',
    area: PERMISSION_AREA.BACKUPS,
    depth: PERMISSION_DEPTH.LOOK,
    label: 'See backups',
    summary:
      'Read the backup posture: which policies exist, where they write, how the recent jobs went — and which volumes on a cluster are still being paid for by applications that no longer exist.',
    scopes: BACKUPS_LOOK,
  },
  {
    key: 'backups:change',
    area: PERMISSION_AREA.BACKUPS,
    depth: PERMISSION_DEPTH.CHANGE,
    label: 'Run backups',
    summary:
      'Read the backup posture and act on it — run a backup now, pause or resume a policy — without deleting a policy or a stored backup.',
    scopes: [...BACKUPS_LOOK, MCP_SCOPE.BACKUP_WRITE],
  },
  {
    key: 'migrations:look',
    area: PERMISSION_AREA.MIGRATIONS,
    depth: PERMISSION_DEPTH.LOOK,
    label: 'See migrations',
    summary:
      'Read the migrations on this instance and how far each one has got.',
    scopes: MIGRATIONS_LOOK,
  },
  {
    key: 'migrations:change',
    area: PERMISSION_AREA.MIGRATIONS,
    depth: PERMISSION_DEPTH.CHANGE,
    label: 'Run migrations',
    summary:
      'Start and cut over migrations between clusters, and read the applications and clusters they move between.',
    scopes: [...MIGRATIONS_LOOK, MCP_SCOPE.APP_READ, MCP_SCOPE.MIGRATION_WRITE],
  },
  {
    key: 'migrations:destroy',
    area: PERMISSION_AREA.MIGRATIONS,
    depth: PERMISSION_DEPTH.DESTROY,
    label: 'Abort and tear down migrations',
    summary:
      'Everything Run migrations can do, plus aborting a migration and destroying the source it moved away from.',
    scopes: [
      ...MIGRATIONS_LOOK,
      MCP_SCOPE.APP_READ,
      MCP_SCOPE.MIGRATION_WRITE,
      MCP_SCOPE.MIGRATION_DESTRUCTIVE,
    ],
  },
  {
    key: 'mail:look',
    area: PERMISSION_AREA.MAIL,
    depth: PERMISSION_DEPTH.LOOK,
    label: 'See mail delivery',
    summary:
      'Read whether mail is set up here, what the provider did with recently sent messages, and which addresses have been suppressed.',
    scopes: [MCP_SCOPE.MAIL_READ],
  },
  {
    key: 'access:look',
    area: PERMISSION_AREA.ACCESS,
    depth: PERMISSION_DEPTH.LOOK,
    label: 'See who has access',
    summary:
      'Read who on this instance can reach what, and what removing or changing one of those grants would take away from them — and change none of it.',
    scopes: [MCP_SCOPE.IAM_READ],
  },
  /**
   * The one switch that lets an agent decide what somebody *else* may reach.
   *
   * It is a group of its own rather than a scope hidden inside another, and
   * that is the condition decision 91 was granted on: `mcp:iam:write` appears
   * in no other group in this file, so it can never ride along with "deploy my
   * applications" — the only way to hold it is to switch this one on, by name,
   * having read the sentence. It is off until somebody does, like every other
   * switch here, and the ladder in `access` makes it read as the deeper of the
   * two rather than as a second decision.
   *
   * A group and not a bare ungrouped scope for a measured reason: the taxonomy
   * asserts that every grantable scope is reachable by some group ("so nothing
   * is only available by hand"), and the screen that mints keys renders groups.
   * A scope in no group at all would be invisible there — not switched off,
   * absent — which is the opposite of what "you see it in the list, off" asks
   * for.
   */
  {
    key: 'access:change',
    area: PERMISSION_AREA.ACCESS,
    depth: PERMISSION_DEPTH.CHANGE,
    label: 'Grant and revoke access',
    summary:
      'Everything See who has access reads, plus giving somebody a role over this instance or taking one away — an agent holding this decides what other people can reach, and it can never hand out more than you hold yourself.',
    scopes: [MCP_SCOPE.IAM_READ, MCP_SCOPE.IAM_WRITE],
  },
];

export const PERMISSION_GROUP_KEYS: string[] = PERMISSION_GROUPS.map(
  (g) => g.key,
);

export function findPermissionGroup(
  key: string,
): PermissionGroupDef | undefined {
  return PERMISSION_GROUPS.find((g) => g.key === key);
}

export function isPermissionGroup(key: string): boolean {
  return findPermissionGroup(key) !== undefined;
}

/**
 * The scopes a set of groups asks for, and which group asked for each one.
 *
 * The provenance is the point: a refusal has to be able to say *which group*
 * exceeded the issuer, not just which scope, or a person cannot tell which
 * switch to leave off.
 */
export function expandPermissionGroups(keys: string[]): {
  scopes: McpScope[];
  askedBy: Map<McpScope, string>;
} {
  const askedBy = new Map<McpScope, string>();
  for (const key of keys) {
    const group = findPermissionGroup(key);
    if (!group) continue;
    for (const scope of group.scopes) {
      if (!askedBy.has(scope)) askedBy.set(scope, group.key);
    }
  }
  return { scopes: [...askedBy.keys()], askedBy };
}

/**
 * Which groups a key carries — derived from its scopes, never stored.
 *
 * Derived on purpose: the grant *is* the scope list, and a second column
 * recording the group it was asked for could drift away from it and would then
 * be a label that lies. The cost is that a key assembled scope by scope reads as
 * the group it happens to match, which is the truth about what it can do.
 *
 * Only the deepest group held in each area is returned: a key carrying
 * `apps:destroy` also satisfies `apps:look`, and saying both would suggest two
 * decisions where a person made one.
 */
export function groupsForScopes(scopes: string[]): string[] {
  const held = new Set(scopes);
  const deepest = new Map<PermissionArea, PermissionGroupDef>();
  for (const group of PERMISSION_GROUPS) {
    if (!group.scopes.every((s) => held.has(s))) continue;
    const current = deepest.get(group.area);
    if (
      !current ||
      DEPTH_ORDER.indexOf(group.depth) > DEPTH_ORDER.indexOf(current.depth)
    ) {
      deepest.set(group.area, group);
    }
  }
  return PERMISSION_GROUPS.filter((g) => deepest.get(g.area) === g).map(
    (g) => g.key,
  );
}

/**
 * Scopes a key holds that no group it carries accounts for.
 *
 * A reading that named only the groups would be a reading that lies by
 * omission: a key with `mcp:app:write` and nothing else matches no group at
 * all, and a panel showing "no group" without showing that scope would describe
 * it as harmless.
 */
export function ungroupedScopes(scopes: string[]): string[] {
  const covered = new Set<string>();
  for (const key of groupsForScopes(scopes)) {
    for (const scope of findPermissionGroup(key)!.scopes) covered.add(scope);
  }
  return scopes.filter((s) => !covered.has(s));
}
