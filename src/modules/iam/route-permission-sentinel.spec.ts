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
   * The list is empty, and it took a product decision to empty it. It held
   * `scale:execute` for as long as the permission existed in three roles and on
   * no route: replicas, restart, stop and start all sat under `AppAccessGuard`
   * with no `@AppAction`, so the action derived from the verb was `app:write`
   * and the permission governed nothing. The four now carry it by name, which
   * is what makes "can restart and scale, cannot touch variables" a credential
   * somebody can actually mint.
   *
   * Emptying it also cost the `sandbox` role a line: a guest held `app:write`
   * and not `scale:execute`, so the same commit that moved the routes had to
   * give it the permission or the public demonstration would have answered 403
   * to the scaling it promises in `sandbox-areas.ts`.
   */
  const LENT_BUT_NEVER_ASKED_FOR: string[] = [];

  it('lends no authority that no route asks for', () => {
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
   *
   * It did. `iam:assign-role` left the list when `mcp:iam:write` was minted, and
   * this test is the record of that being a decision rather than a slip: the
   * author granted it (91) on the condition that the power be a catalogue entry
   * anybody can switch off, which is what the scope, its lone group
   * (`access:change`) and its absence from every tier now are. The permission
   * itself did not move — conferring still asks for it on the route, and a key
   * is still never worth more than whoever minted it.
   */
  const NO_SCOPE_CARRIES: string[] = [
    IAM_PERMISSION.CLUSTER_DESTROY,
    IAM_PERMISSION.IAM_MANAGE_USERS,
    IAM_PERMISSION.INTEGRATION_MANAGE,
    IAM_PERMISSION.SANDBOX_OPERATE,
    IAM_PERMISSION.SHOWCASE_PUBLISH,
    // Replacing the control plane — and applying migrations a rollback does not
    // undo — is not something a key should be able to do on its own. The route
    // is reachable by a session and by an unscoped credential; widening
    // `allows` to reach it is the decision this line exists to make explicit.
    IAM_PERMISSION.PLATFORM_UPDATE,
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
   * Was twenty-six: the whole management plane — deleting a DNS zone, a
   * firewall, a server, a project, a backup policy — protected by a section and
   * by nothing a ceiling can read. Each one now also names the permission its
   * section already demands at GLOBAL scope, so the annotation is strictly
   * weaker than the gate that was already there and takes nothing from anybody
   * who reaches the route today.
   *
   * Zero, and it stays zero: a new destructive route behind a section only is a
   * route no agent key can be scoped away from.
   */
  it('leaves none protected by a section alone', () => {
    const gated = invisible.filter((r) => r.section);
    expect(gated.map((r) => `${r.method} ${r.path}`)).toEqual([]);
  });

  /**
   * Was twenty-five. Three remained after the census, and each is a decision
   * rather than an omission — which is why they are named here with the reason,
   * in the shape decision 97 used for the tool the ceiling refuses on purpose.
   * A fourth has since arrived from decision 104, not from the census: it is
   * the third instance of the same rule, "switching off a credential you
   * brought yourself never asks for a permission".
   *
   * The other twenty-two split exactly the way the pass expected: most needed a
   * permission, and four needed the *other* question answered first — not
   * "which permission" but "whose row is this", which is a lookup and not a
   * decorator. `DELETE /catalog/installs/:id`, `DELETE /endpoints/:id`,
   * `DELETE /image-registry/:imageId` and its tag sibling took an id and wrote,
   * so any authenticated account reached another tenant's row by guessing a
   * uuid. Those four carry both halves now: the permission the ceiling reads,
   * and the ownership assertion that decides.
   */
  const OUTSIDE_THE_CEILING_ON_PURPOSE: string[] = [
    // Answers 405 to every caller and destroys nothing: serving is per request
    // and the protocol revision this implements has no sessions to end. It is in
    // the census because the verb is DELETE, which decision 86 already says is
    // the wrong criterion — irreversibility is, and there is nothing here to
    // reverse.
    'DELETE /mcp',
    // The caller's own credential, and both of them are the same decision.
    // Neither takes an id belonging to anybody else: the revoke matches on the
    // caller's own userId and the PAT route has no id at all. Turning a
    // credential off must never need a permission — a principal who may hold one
    // and may not revoke it is the worst state a credential model can be in, and
    // the sandbox fence opens the first of these to a guest for exactly that
    // reason ("switch off an agent you connected"). The residue is named and
    // accepted: an agent key can revoke its principal's other keys, or their
    // GHCR token, which is a nuisance to its owner and never an escalation.
    'DELETE /auth/api-keys/:id',
    'DELETE /repositories/github-app/packages-pat',
    // The fourth, and the same decision as the two above rather than a new one.
    // Decision 104 splits an inference connection into two levels: the
    // installation's row, which keeps `integration:manage` on its own
    // `DELETE /inference/connections/:id`, and a person's own, which anybody
    // may bring and must therefore be able to take away again. This route
    // reaches nothing but the caller's own row — the service compares
    // `owner_user_id` to the caller and answers 404 otherwise — so no
    // permission could narrow it further and one could only strand somebody
    // holding a key she may not unplug.
    //
    // It is a separate path from the gated one precisely so the gate survives:
    // an agent scope still cannot unplug the model the installation speaks
    // through, which is the reason the sibling carries `integration:manage`.
    'DELETE /inference/connections/mine/:id',
    // The fifth, and the third instance of the same rule rather than a new
    // decision: taking back a permission you granted yourself must never ask
    // for a permission. A concession is not a capability — it only removes the
    // pause on a route the guards already let through — so revoking one can
    // only ever narrow what an agent may do, and a principal who could grant
    // one but not withdraw it is the worst state a consent model can be in.
    //
    // It is also the one route in this list that is *narrower* than a
    // permission could make it: the handler refuses agent credentials outright
    // (`AGENT_MAY_NOT_DECIDE`) and matches on the caller's own `ownerUserId`,
    // answering 404 for anybody else's row. The sandbox fence opens it to a
    // guest for the same reason it opens `DELETE /auth/api-keys/:id`.
    'DELETE /agent/concessions/:id',
  ];

  it('leaves only the five named here with no permission at all', () => {
    const ungated = invisible
      .filter((r) => !r.section)
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    expect(ungated).toEqual([...OUTSIDE_THE_CEILING_ON_PURPOSE].sort());
  });

  it('names the files they live in, so a new one shows up as a new file', () => {
    const files = [...new Set(invisible.map((r) => r.file))].sort();
    expect(files).toEqual([
      'modules/action-cycle/action-cycle.controller.ts',
      'modules/auth/controllers/api-keys.controller.ts',
      'modules/inference/controllers/inference.controller.ts',
      'modules/mcp/mcp.controller.ts',
      'modules/repositories/controllers/github-app-oauth.controller.ts',
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

  const REACH_MANAGEMENT: IamRole[] = [IAM_ROLE.MAINTAINER, IAM_ROLE.OWNER];

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
   * still say `app:read` and not `cluster:read`, which would be the honest name.
   *
   * It used to be that neither an `editor` nor a sandbox guest held any cluster
   * permission, and both reached all four for real. Half of that is now false:
   * `operator` carries `cluster:read`, because the rung above the viewer could
   * not hold less than the viewer. The other half is what still decides the
   * annotation — a guest holds neither, calls all four through the fence, and
   * naming the honest permission would take the public demonstration down.
   */
  it('withholds every cluster permission from the guest, who reaches those routes anyway', () => {
    expect({
      clusterRead: holds(IAM_ROLE.SANDBOX, IAM_PERMISSION.CLUSTER_READ),
      clusterManage: holds(IAM_ROLE.SANDBOX, IAM_PERMISSION.CLUSTER_MANAGE),
      appRead: holds(IAM_ROLE.SANDBOX, IAM_PERMISSION.APP_READ),
      appCreate: holds(IAM_ROLE.SANDBOX, IAM_PERMISSION.APP_CREATE),
    }).toEqual({
      clusterRead: false,
      clusterManage: false,
      appRead: true,
      appCreate: true,
    });
  });

  /**
   * And the guest scales, which four routes now ask for by name. This is the
   * assertion that would have caught the regression the annotation pass could
   * have shipped: `scale:execute` on the routes without `scale:execute` on the
   * role is a silent 403 on the one verb the demo copy advertises.
   */
  it('gives the guest the permission the runtime routes now ask for', () => {
    expect(holds(IAM_ROLE.SANDBOX, IAM_PERMISSION.SCALE_EXECUTE)).toBe(true);
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

  /**
   * The narrowings the second pass took, stated rather than discovered later.
   *
   * Everything the *sections* imply cost nobody anything: the permission asked
   * of those routes is the one their section already demands at global scope, so
   * it is strictly weaker than the gate in front of it. These are the routes
   * that carried **no** gate at all, where naming an honest permission does take
   * something away from somebody who could call them yesterday.
   *
   * Removing a cluster's DNS zone, its ACME issuers or a SAN certificate breaks
   * TLS for every application on that cluster, and the neighbouring
   * `DELETE /dns/zones/:id` has always sat in the `infrastructure` section. An
   * `operator` — defined as "cannot manage access or infrastructure" — reached
   * all of them through the cluster page, and no longer does.
   *
   * The inference connection is the instance's own credential to a model
   * provider: one unowned row every assistant borrows, offered on a settings
   * screen shown to everybody. `integration:manage` and not `cluster:manage`,
   * because it touches no cluster and because no agent scope carries it.
   */
  it('takes the cluster DNS and certificate deletes away from the two lower rungs', () => {
    for (const role of [IAM_ROLE.VIEWER, IAM_ROLE.OPERATOR]) {
      expect({
        role,
        holds: holds(role, IAM_PERMISSION.CLUSTER_MANAGE),
      }).toEqual({ role, holds: false });
    }
    for (const role of REACH_MANAGEMENT) {
      expect({
        role,
        holds: holds(role, IAM_PERMISSION.CLUSTER_MANAGE),
      }).toEqual({ role, holds: true });
    }
  });

  it('takes the instance model credential away from everyone below maintainer', () => {
    expect(
      Object.keys(BUILTIN_ROLES).filter((role) =>
        holds(role as IamRole, IAM_PERMISSION.INTEGRATION_MANAGE),
      ),
    ).toEqual([IAM_ROLE.MAINTAINER, IAM_ROLE.OWNER]);
  });

  /**
   * And the guest keeps everything the console family now asks for by name.
   *
   * Seven console routes — flushing a cache, dropping a stream, deleting a
   * bucket or an object or a secret — stopped being invisible and now ask for
   * `app:write`. The guest reaches them for real (they are not on the fence's
   * refusal list and `AppOwnershipGuard` answers for its own applications), so a
   * permission it did not hold would be a 403 in the middle of the public
   * demonstration.
   */
  it('gives the guest the permission the console routes now ask for', () => {
    expect(holds(IAM_ROLE.SANDBOX, IAM_PERMISSION.APP_WRITE)).toBe(true);
  });
});
