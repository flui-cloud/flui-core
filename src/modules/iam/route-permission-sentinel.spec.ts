import * as ts from 'typescript';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { IAM_PERMISSION } from './constants/iam-permissions';
import { BUILTIN_ROLES, IAM_ROLE, IamRole } from './constants/iam-roles';
import { SCOPE_AUTHORITY } from '../auth/constants/api-key-scopes';
import { PERMISSION_GROUPS } from '../auth/constants/api-key-groups';
import { ALL_TOOLS } from '../mcp/tools/tool-registry';

/**
 * The sentinel over the two things nobody was checking (decisions 82 and 88.2).
 *
 * The credential ceiling reads `@RequirePermission` and `@AppAction` and
 * nothing else, and `SCOPE_AUTHORITY.allows` declares what each agent scope may
 * exercise. Those are two lists written in two files by two hands, and until
 * now nothing compared them. This asks both questions in one pass over the same
 * surface, because they are the same pass:
 *
 *  1. **does the declaration match the routes?** A route that starts asking for
 *     `app:deploy` while the table says otherwise makes the ceiling refuse a
 *     call the group exists to permit — a 403 on a legitimate function, which
 *     is the hardest kind of failure to diagnose.
 *  2. **which destructive routes ask for no permission at all?** A comparison
 *     between two lists never sees the line missing from both. A route carrying
 *     neither decorator is invisible to the ceiling: no scope names it, so no
 *     key can be scoped away from it.
 *
 * It reads the source rather than booting Nest on purpose — the whole point is
 * to see what is written on 609 route handlers without running any of them.
 */
const SRC = join(__dirname, '..', '..');

const HTTP = [
  'Get',
  'Post',
  'Put',
  'Patch',
  'Delete',
  'Head',
  'Options',
  'All',
];

interface RouteRecord {
  file: string;
  controller: string;
  method: string;
  path: string;
  handler: string;
  /** The literal decorator argument, e.g. `IAM_PERMISSION.APP_READ`. */
  permission?: string;
  appAction?: string;
  section?: string;
  guards: string[];
  isPublic: boolean;
}

function controllerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...controllerFiles(full));
    else if (entry.endsWith('.controller.ts') && !entry.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

function nameOf(d: ts.Decorator): string {
  const e = d.expression;
  if (ts.isCallExpression(e)) {
    const x = e.expression;
    return ts.isIdentifier(x) ? x.text : x.getText();
  }
  return ts.isIdentifier(e) ? e.text : e.getText();
}

function argsOf(d: ts.Decorator): string[] {
  const e = d.expression;
  return ts.isCallExpression(e) ? e.arguments.map((a) => a.getText()) : [];
}

function literal(text: string | undefined): string {
  return (text ?? '').replace(/^['"`]|['"`]$/g, '');
}

function collectRoutes(): RouteRecord[] {
  const routes: RouteRecord[] = [];
  for (const file of controllerFiles(join(SRC, 'modules'))) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    source.forEachChild((node) => {
      if (!ts.isClassDeclaration(node)) return;
      const classDecorators = ts.getDecorators(node) ?? [];
      const controller = classDecorators.find(
        (d) => nameOf(d) === 'Controller',
      );
      if (!controller) return;
      const base = literal(argsOf(controller)[0]);
      const pick = (decorators: readonly ts.Decorator[], want: string) =>
        decorators.find((d) => nameOf(d) === want);
      const classGuards = classDecorators
        .filter((d) => nameOf(d) === 'UseGuards')
        .flatMap((d) => argsOf(d));
      const classPermission = pick(classDecorators, 'RequirePermission');
      const classAction = pick(classDecorators, 'AppAction');
      const classSection = pick(classDecorators, 'RequireSection');
      const classPublic = classDecorators.some((d) => nameOf(d) === 'Public');

      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member)) continue;
        const decorators = ts.getDecorators(member) ?? [];
        const verb = decorators.find((d) => HTTP.includes(nameOf(d)));
        if (!verb) continue;
        const permission =
          pick(decorators, 'RequirePermission') ?? classPermission;
        const action = pick(decorators, 'AppAction') ?? classAction;
        const section = pick(decorators, 'RequireSection') ?? classSection;
        const path =
          ('/' + [base, literal(argsOf(verb)[0])].filter(Boolean).join('/'))
            .replace(/\/+/g, '/')
            .replace(/(.)\/$/, '$1') || '/';
        routes.push({
          file: file.slice(SRC.length + 1).replace(/\\/g, '/'),
          controller: node.name?.text ?? '?',
          method: nameOf(verb).toUpperCase(),
          path,
          handler: ts.isIdentifier(member.name) ? member.name.text : '?',
          permission: permission ? argsOf(permission)[0] : undefined,
          appAction: action ? argsOf(action)[0] : undefined,
          section: section ? literal(argsOf(section)[0]) : undefined,
          guards: [
            ...classGuards,
            ...decorators
              .filter((d) => nameOf(d) === 'UseGuards')
              .flatMap((d) => argsOf(d)),
          ],
          isPublic:
            classPublic || decorators.some((d) => nameOf(d) === 'Public'),
        });
      }
    });
  }
  return routes;
}

/** `IAM_PERMISSION.APP_READ` (as written on the decorator) → `app:read`. */
function permissionValue(expression: string | undefined): string | undefined {
  if (!expression) return undefined;
  const key = /^IAM_PERMISSION\.([A-Z_]+)$/.exec(expression)?.[1];
  if (key) return (IAM_PERMISSION as Record<string, string>)[key];
  return literal(expression) || undefined;
}

const underAppAccessGuard = (r: RouteRecord): boolean =>
  r.guards.some((g) => g.includes('AppAccessGuard'));

/**
 * What the ceiling will be asked for on this route, or `undefined` when the
 * route is invisible to it.
 *
 * `AppAccessGuard` derives an action from the HTTP method when no `@AppAction`
 * says otherwise, so a route behind it is inside the ceiling even with no
 * decorator of its own — but only if it names an application, which every route
 * under that guard does by construction.
 */
function ceilingPermission(r: RouteRecord): string | undefined {
  const explicit =
    permissionValue(r.appAction) ?? permissionValue(r.permission);
  if (explicit) return explicit;
  if (!underAppAccessGuard(r)) return undefined;
  return r.method === 'GET'
    ? IAM_PERMISSION.APP_READ
    : IAM_PERMISSION.APP_WRITE;
}

const ROUTES = collectRoutes();

const normalise = (path: string): string =>
  path.replace(/:[A-Za-z0-9_]+/g, ':x');

const BY_ROUTE = new Map<string, RouteRecord[]>();
for (const r of ROUTES) {
  const key = `${r.method} ${normalise(r.path)}`;
  BY_ROUTE.set(key, [...(BY_ROUTE.get(key) ?? []), r]);
}

const lookup = (declared: string): RouteRecord[] => {
  const space = declared.indexOf(' ');
  const verb = declared.slice(0, space).toUpperCase();
  return BY_ROUTE.get(`${verb} ${normalise(declared.slice(space + 1))}`) ?? [];
};

describe('the ceiling and the routes say the same thing', () => {
  const allowsUnion = new Set<string>(
    Object.values(SCOPE_AUTHORITY).flatMap((a) => a.allows),
  );

  /**
   * A permission in `allows` that no route asks for lends authority nobody
   * needs — either the table is ahead of the product or the permission was
   * renamed on the route and not here.
   *
   * There is exactly one, and finding it is what this sentinel is for.
   * `scale:execute` is a real permission held by `editor`, `manager` and
   * `owner`, and `mcp:app:write` names it so that a "deploy and operate" key
   * can scale — but **no route asks for it**: `PATCH /applications/:id/replicas`
   * sits under `AppAccessGuard` with no `@AppAction`, so the action derived
   * from the verb is `app:write` and the permission is never consulted.
   *
   * It is left as it is rather than corrected here, and the reason is
   * measurable: the `sandbox` role holds `app:write` and does NOT hold
   * `scale:execute`, so writing `@AppAction(SCALE_EXECUTE)` on the replicas
   * route would take scaling away from every guest of the demonstration. Which
   * of the two is wrong — the role or the route — is a product decision, not a
   * decorator.
   */
  const LENT_BUT_NEVER_ASKED_FOR: string[] = [IAM_PERMISSION.SCALE_EXECUTE];

  it('lends no authority that no route asks for, but one', () => {
    const demanded = new Set(
      ROUTES.map(ceilingPermission).filter((p): p is string => !!p),
    );
    const lent = [...allowsUnion].filter((p) => !demanded.has(p)).sort();
    expect(lent).toEqual([...LENT_BUT_NEVER_ASKED_FOR].sort());
  });

  /**
   * The permissions routes ask for that no agent scope carries, on purpose.
   *
   * Every one of them is a decision already taken: destroying a cluster, minting
   * accounts, the instance's own GitHub credentials, publishing to the showcase,
   * operating the demonstration. An agent reaching any of these is a decision
   * somebody has to make explicitly, and the way to make it is to widen
   * `allows` — which turns this list red first.
   */
  const NO_SCOPE_CARRIES: string[] = [
    IAM_PERMISSION.CLUSTER_DESTROY,
    IAM_PERMISSION.IAM_ASSIGN_ROLE,
    IAM_PERMISSION.IAM_MANAGE_USERS,
    IAM_PERMISSION.INTEGRATION_MANAGE,
    IAM_PERMISSION.SANDBOX_OPERATE,
    IAM_PERMISSION.SHOWCASE_PUBLISH,
  ];

  it('asks for no permission outside the declaration except the six named here', () => {
    const outside = [
      ...new Set(
        ROUTES.map(ceilingPermission)
          .filter((p): p is string => !!p)
          .filter((p) => !allowsUnion.has(p)),
      ),
    ].sort();
    expect(outside).toEqual([...NO_SCOPE_CARRIES].sort());
  });
});

describe('every tool goes to a route that exists, under a scope that carries it', () => {
  const declarations = ALL_TOOLS.flatMap((tool) =>
    (tool.routes ?? []).map((route) => ({
      tool: tool.name,
      scope: tool.scope as keyof typeof SCOPE_AUTHORITY,
      route,
    })),
  );

  /**
   * Without this the question below is silently vacuous: a declared route that
   * matches no handler contributes no permission, so it can never disagree with
   * anything. It is also the same declaration the sandbox visibility filter
   * reads to decide what a guest is offered.
   */
  it('resolves every declared route to a handler in the tree', () => {
    const missing = declarations
      .filter((d) => lookup(d.route).length === 0)
      .map((d) => `${d.tool} → ${d.route}`)
      .sort();
    expect(missing).toEqual([]);
  });

  /**
   * The refusals that are deliberate: the tool exists for the in-product
   * assistant and for an unscoped credential, and a scoped agent key is meant
   * to be turned away from it.
   */
  const CEILING_REFUSES_ON_PURPOSE: string[] = [
    // Re-making the instance's own GitHub App is an operator act, so
    // `integration:manage` is in no scope's `allows`. The tool still works for a
    // session and for the CLI key, neither of which declares a ceiling.
    'github_setup → POST /repositories/github/setup/github-app/manifest-start',
  ];

  /**
   * Asked of the **group**, not of the tool's own scope, because the group is
   * what a person switches on and the ceiling is the union over everything the
   * key carries. `gateway_route_remove` is scoped `mcp:app:destructive`, whose
   * `allows` is `app:delete` alone, and the route it deletes through asks for
   * `app:write` — read one scope at a time that looks like a bug, and it is
   * not: the only group that offers the tool is `apps:destroy`, which names
   * `mcp:app:write` beside it, so the key that can call the tool can also pass
   * the route.
   */
  it('never sends a tool to a route the group offering it cannot exercise', () => {
    const refused: string[] = [];
    for (const d of declarations) {
      const groups = PERMISSION_GROUPS.filter((g) =>
        (g.scopes as string[]).includes(d.scope),
      );
      for (const group of groups) {
        const allows = new Set<string>(
          group.scopes.flatMap((s) => SCOPE_AUTHORITY[s]?.allows ?? []),
        );
        for (const route of lookup(d.route)) {
          const required = ceilingPermission(route);
          if (required && !allows.has(required)) {
            refused.push(`${d.tool} → ${d.route}`);
          }
        }
      }
    }
    expect([...new Set(refused)].sort()).toEqual(
      [...CEILING_REFUSES_ON_PURPOSE].sort(),
    );
  });
});

/**
 * The question the comparison above cannot ask.
 *
 * Irreversibility is the criterion, not the HTTP verb — but
 * irreversibility is not written anywhere a reader can walk, so this
 * approximates it with the verb plus the vocabulary the handlers use, and then
 * pins the answer. The number is the point: it may only go down without
 * somebody saying so out loud.
 */
describe('destructive routes the ceiling cannot see', () => {
  const DESTRUCTIVE =
    /destroy|purge|wipe|prune|teardown|revoke|delete|remove|drop|truncate|reset|uninstall|expire|abort/i;

  const invisible = ROUTES.filter(
    (r) =>
      !r.isPublic &&
      !ceilingPermission(r) &&
      (r.method === 'DELETE' ||
        DESTRUCTIVE.test(r.path) ||
        DESTRUCTIVE.test(r.handler)),
  );

  /**
   * Section-gated, so no ordinary caller reaches them — but a credential
   * carrying `mcp:*` scopes reaches them exactly as far as the person behind it
   * does, because no scope names the permission they do not ask for. Twenty-six
   * routes across the management plane; giving each one the permission its
   * section already implies is a pass of its own, with its own live check.
   */
  it('counts the ones a section still protects', () => {
    const gated = invisible.filter((r) => r.section);
    expect(gated).toHaveLength(26);
  });

  /**
   * The ones with no authorization decorator at all — neither a permission, nor
   * an application action, nor a section, nor `AppAccessGuard`.
   *
   * Most are not open: the console family carries `AppOwnershipGuard`, and
   * several answer 404 for a row that is not the caller's. What they have in
   * common is that the ceiling cannot see them, so an agent key scoped to reads
   * deletes through them over plain HTTP. This is a census, not an accusation —
   * and a number that must not grow by accident.
   */
  it('counts the ones no decorator protects', () => {
    const ungated = invisible.filter((r) => !r.section);
    expect(ungated).toHaveLength(25);
  });

  it('names the files they live in, so a new one shows up as a new file', () => {
    const files = [...new Set(invisible.map((r) => r.file))].sort();
    expect(files).toEqual([
      'modules/access/access.controller.ts',
      'modules/app-builds/controllers/standalone-builds.controller.ts',
      'modules/auth/controllers/api-keys.controller.ts',
      'modules/authz/controllers/authz-install.controller.ts',
      'modules/backups/controllers/backup-destinations.controller.ts',
      'modules/backups/controllers/backup-policies.controller.ts',
      'modules/catalog/controllers/catalog.controller.ts',
      'modules/database-console/controllers/cache-console.controller.ts',
      'modules/database-console/controllers/messaging-console.controller.ts',
      'modules/database-console/controllers/object-store-console.controller.ts',
      'modules/database-console/controllers/secrets-console.controller.ts',
      'modules/db-lifecycle/controllers/db-lifecycle.controller.ts',
      'modules/demo/controllers/demo-admin.controller.ts',
      'modules/dns/controllers/app-endpoint.controller.ts',
      'modules/dns/controllers/cluster-dns-zone.controller.ts',
      'modules/dns/controllers/dns-zone-replica.controller.ts',
      'modules/dns/controllers/dns-zone.controller.ts',
      'modules/dns/controllers/san-certificate.controller.ts',
      'modules/image-registry/controllers/image-registry.controller.ts',
      'modules/inference/controllers/inference.controller.ts',
      'modules/infrastructure/clusters/clusters.controller.ts',
      'modules/infrastructure/firewalls/controllers/cluster-firewalls.controller.ts',
      'modules/infrastructure/firewalls/controllers/firewalls.controller.ts',
      'modules/infrastructure/servers/servers.controller.ts',
      'modules/infrastructure/vnets/controllers/vnets.controller.ts',
      'modules/mail/controllers/mail-connections.controller.ts',
      'modules/mail/controllers/mail.controller.ts',
      'modules/management/controllers/management.controller.ts',
      'modules/mcp/mcp.controller.ts',
      'modules/projects/projects.controller.ts',
      'modules/providers/controllers/provider-firewalls.controller.ts',
      'modules/repositories/controllers/github-app-oauth.controller.ts',
      'modules/repositories/controllers/repositories.controller.ts',
    ]);
  });
});

/**
 * How a permission was chosen for each route.
 *
 * Thirty-nine routes gained a `@RequirePermission` so the ceiling could see
 * them, and a permission chosen badly does not fail to compile — it answers 403
 * to somebody who was doing their job yesterday. The rule applied was: name a
 * permission every principal that reaches the route today already holds. These
 * are the four facts that made that rule decidable; if a role's definition
 * changes, this goes red before anybody's screen does.
 */
describe('the ground the annotation pass stood on', () => {
  const holds = (role: IamRole, permission: string): boolean =>
    (BUILTIN_ROLES[role].permissions as readonly string[]).includes(permission);

  const REACH_MANAGEMENT: IamRole[] = [IAM_ROLE.MANAGER, IAM_ROLE.OWNER];

  it('gives every built-in role app:read, which is why app:read takes nothing', () => {
    for (const role of Object.keys(BUILTIN_ROLES) as IamRole[]) {
      expect({ role, holds: holds(role, IAM_PERMISSION.APP_READ) }).toEqual({
        role,
        holds: true,
      });
    }
  });

  /**
   * `cluster:manage` at global scope is the `full` gate of the `backup`, `mail`
   * and `infrastructure` sections, so these two are the only roles that reach
   * the routes behind them.
   */
  it('gives everyone who can enter those sections the permission now asked of them', () => {
    for (const role of REACH_MANAGEMENT) {
      expect({
        role,
        clusterManage: holds(role, IAM_PERMISSION.CLUSTER_MANAGE),
        clusterRead: holds(role, IAM_PERMISSION.CLUSTER_READ),
        migrationExecute: holds(role, IAM_PERMISSION.MIGRATION_EXECUTE),
        appRead: holds(role, IAM_PERMISSION.APP_READ),
      }).toEqual({
        role,
        clusterManage: true,
        clusterRead: true,
        migrationExecute: true,
        appRead: true,
      });
    }
  });

  /**
   * The reason the migration lists, the cluster list and `resource-availability`
   * say `app:read` and not `cluster:read`, which would be the honest name: an
   * `editor` and a sandbox guest hold neither `cluster:read` nor
   * `cluster:manage`, and both reach all four for real.
   */
  it('withholds every cluster permission from the editor and the guest', () => {
    for (const role of [IAM_ROLE.EDITOR, IAM_ROLE.SANDBOX]) {
      expect({
        role,
        clusterRead: holds(role, IAM_PERMISSION.CLUSTER_READ),
        clusterManage: holds(role, IAM_PERMISSION.CLUSTER_MANAGE),
        appRead: holds(role, IAM_PERMISSION.APP_READ),
        appCreate: holds(role, IAM_PERMISSION.APP_CREATE),
      }).toEqual({
        role,
        clusterRead: false,
        clusterManage: false,
        appRead: true,
        appCreate: true,
      });
    }
  });

  /**
   * The one deliberate narrowing. `viewer` is defined as read-only, and two
   * routes it could call before now ask for a write: importing repositories and
   * publishing a cluster's wildcard record.
   */
  it('leaves the viewer without the writes two routes now ask for', () => {
    expect({
      appWrite: holds(IAM_ROLE.VIEWER, IAM_PERMISSION.APP_WRITE),
      appCreate: holds(IAM_ROLE.VIEWER, IAM_PERMISSION.APP_CREATE),
    }).toEqual({ appWrite: false, appCreate: false });
  });
});
