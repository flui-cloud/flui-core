/**
 * The Access half of the example world: who is in the organisation, what each
 * of them may reach, and how that was written down.
 *
 * This section is a stand-in and not a projection, and the reason is the whole
 * invariant of the sandbox: the real answer here is the list of the other
 * guests and of the operator, and no guest ever reads either. Refusing it
 * outright was the other option, and it costs more than it saves — access
 * control is the thing an evaluator most wants to see, and a small organisation
 * with four people and their different reach demonstrates it better than any
 * amount of prose.
 *
 * The people and applications come from `sandbox-world-core.ts`, so the names
 * here are the same ones Mail sends from and Backup protects.
 */
import {
  APPS,
  CLUSTER_ID,
  CLUSTER_NAME,
  daysAgo,
  hoursAgo,
  mark,
  minutesAgo,
  PEOPLE,
  PROVIDER,
} from './sandbox-world-core';

const [MARTA, TOMAS, AISHA, JONAS] = PEOPLE;

const ON_CALL_GROUP = 'on-call';

export function exampleUsers(now: number) {
  return PEOPLE.map((person, index) =>
    mark({
      id: person.id,
      email: person.email,
      firstName: person.firstName,
      lastName: person.lastName,
      displayName: `${person.firstName} ${person.lastName}`,
      role: person.identityRole,
      state: 'ACTIVE',
      isBootstrapAdmin: index === 0,
      isSystemUser: false,
      createdAt: daysAgo(now, 26 - index * 3),
    }),
  );
}

/**
 * The role catalogue, which is now simply the real one: four rungs.
 *
 * It used to be "the real one minus the two machine roles", because `sandbox`
 * and `showcase_viewer` were served to everybody and had to be subtracted here
 * so the demonstration explained the product rather than the sandbox. They are
 * subtracted at the source now — `listRolesFor` serves only the assignable
 * roles — so this list and the live one describe the same four things, which is
 * the whole point of a stand-in.
 *
 * Every entry carries `grantable: false`: a guest may look at the model and
 * change nothing in it, and the screen builds its pickers from that flag. The
 * example world says the same thing the fence does, instead of offering a
 * choice that would be refused one layer down.
 */
export function exampleIamRoles() {
  return [
    mark({
      key: 'viewer',
      name: 'Viewer',
      description: 'Read-only across everything in scope.',
      permissions: ['app:read', 'cluster:read'],
      assignable: true,
      grantable: false,
      revocable: false,
    }),
    mark({
      key: 'operator',
      name: 'Operator',
      description:
        'View, deploy, operate and remove the apps in scope. Cannot manage access or infrastructure.',
      permissions: [
        'app:read',
        'app:write',
        'app:deploy',
        'app:create',
        'app:delete',
        'scale:execute',
        'migration:execute',
        'cluster:read',
      ],
      assignable: true,
      grantable: false,
      revocable: false,
    }),
    mark({
      key: 'maintainer',
      name: 'Maintainer',
      description:
        'Operator + the installation itself: clusters, access, integrations, the showcase and the demo.',
      permissions: [
        'app:read',
        'app:write',
        'app:deploy',
        'app:create',
        'app:delete',
        'scale:execute',
        'migration:execute',
        'cluster:read',
        'cluster:manage',
        'iam:assign-role',
        'iam:read-access',
        'integration:manage',
        'showcase:publish',
        'sandbox:operate',
      ],
      assignable: true,
      grantable: false,
      revocable: false,
    }),
    mark({
      key: 'owner',
      name: 'Owner',
      description:
        'Everything, everywhere, including who else may run this installation.',
      permissions: [
        'app:read',
        'app:write',
        'app:deploy',
        'app:create',
        'app:delete',
        'scale:execute',
        'migration:execute',
        'cluster:read',
        'cluster:manage',
        'cluster:destroy',
        'iam:assign-role',
        'iam:read-access',
        'iam:manage-users',
        'integration:manage',
        'showcase:publish',
        'sandbox:operate',
      ],
      assignable: true,
      grantable: false,
      revocable: false,
    }),
  ];
}

/**
 * Four grants that are each a different shape of scope, on purpose: the whole
 * argument of the section is that *which resources* is a target and not a role.
 */
export function exampleIamGrants(now: number) {
  return [
    mark({
      id: 'example-grant-1',
      principalType: 'user',
      principalRef: MARTA.email,
      role: 'maintainer',
      scopeType: 'global',
      scopeRef: null,
      selector: null,
      createdAt: daysAgo(now, 26),
    }),
    mark({
      id: 'example-grant-2',
      principalType: 'user',
      principalRef: TOMAS.email,
      role: 'operator',
      scopeType: 'selector',
      scopeRef: null,
      selector: { project: 'commerce' },
      createdAt: daysAgo(now, 21),
    }),
    mark({
      id: 'example-grant-3',
      principalType: 'user',
      principalRef: AISHA.email,
      role: 'operator',
      scopeType: 'selector',
      scopeRef: null,
      selector: { slugs: [APPS[0].slug] },
      createdAt: daysAgo(now, 14),
    }),
    mark({
      id: 'example-grant-4',
      principalType: 'group',
      principalRef: ON_CALL_GROUP,
      role: 'viewer',
      scopeType: 'cluster',
      scopeRef: CLUSTER_ID,
      selector: null,
      createdAt: daysAgo(now, 9),
    }),
  ];
}

export function exampleIamGroups(now: number) {
  return [
    mark({
      id: 'example-group-1',
      name: ON_CALL_GROUP,
      description: 'Whoever is carrying the pager this week.',
      members: [JONAS.email, TOMAS.email],
      createdAt: daysAgo(now, 9),
    }),
  ];
}

/** The applications a grant can be pointed at, on the selector axes. */
export function exampleIamResources() {
  return APPS.map((app) =>
    mark({
      id: app.id,
      slug: app.slug,
      name: app.name,
      type: 'user',
      kind: app.kind,
      clusterId: CLUSTER_ID,
      clusterName: CLUSTER_NAME,
      provider: PROVIDER,
      project: app.project,
      tags: [...app.tags],
      owner: MARTA.email,
    }),
  );
}

/** The "who" picker: the same people, plus the one group they belong to. */
export function exampleIamPrincipals() {
  return [
    ...PEOPLE.map((person) =>
      mark({
        type: 'user',
        ref: person.email,
        displayName: `${person.firstName} ${person.lastName} (${person.email})`,
      }),
    ),
    mark({
      type: 'group',
      ref: ON_CALL_GROUP,
      displayName: `${ON_CALL_GROUP} (group)`,
    }),
  ];
}

/**
 * What the example organisation did lately, the shape Access → Activity reads:
 * changes, a refusal and reads of application data, by the same people the
 * other tabs list and on the same applications the rest of the world runs.
 */
const OUTCOME_STATUS = { ok: 200, refused: 403, failed: 500 } as const;

export function exampleAuditEvents(now: number) {
  const [storefront, ordersApi, ordersDb] = APPS;
  const event = (
    index: number,
    at: string,
    who: (typeof PEOPLE)[number] | null,
    action: string,
    target: Record<string, string> | null,
    outcome: 'ok' | 'refused' | 'failed',
    extra: {
      dataAccess?: boolean;
      permission?: string;
      actorKind?: string;
    } = {},
  ) =>
    mark({
      id: `example-audit-${index}`,
      at,
      userId: who?.id ?? null,
      email: who?.email ?? null,
      actorKind: extra.actorKind ?? (who ? 'user' : 'system'),
      actorKeyId: null,
      action,
      target,
      status: OUTCOME_STATUS[outcome],
      outcome,
      permission: extra.permission ?? null,
      dataAccess: extra.dataAccess ?? false,
    });
  return [
    event(
      1,
      minutesAgo(now, 12),
      TOMAS,
      'POST /applications/:id/deploy',
      { id: ordersApi.id },
      'ok',
    ),
    event(
      2,
      minutesAgo(now, 41),
      AISHA,
      'GET /applications/:id/logs',
      { id: storefront.id },
      'ok',
      { dataAccess: true },
    ),
    event(
      3,
      hoursAgo(now, 2),
      JONAS,
      'POST /applications/:id/db/query',
      { id: ordersDb.id },
      'refused',
      {
        dataAccess: true,
        permission: 'data:access',
      },
    ),
    event(4, hoursAgo(now, 3), MARTA, 'POST /iam/grants', null, 'ok', {
      permission: 'iam:assign-role',
    }),
    event(
      5,
      hoursAgo(now, 5),
      TOMAS,
      'POST /applications/:id/restart',
      { id: storefront.id },
      'ok',
      {
        actorKind: 'agent',
      },
    ),
    event(
      6,
      hoursAgo(now, 9),
      null,
      'ssh certificate issued',
      { cluster: CLUSTER_NAME },
      'ok',
      { dataAccess: true },
    ),
    event(
      7,
      daysAgo(now, 1),
      AISHA,
      'POST /backup-policies/:id/run',
      { id: 'example-backup-policy-1' },
      'ok',
    ),
    event(
      8,
      daysAgo(now, 1),
      MARTA,
      'PATCH /infrastructure/clusters/:id/egress-policy',
      { id: CLUSTER_ID },
      'ok',
    ),
    event(
      9,
      daysAgo(now, 2),
      JONAS,
      'DELETE /applications/:id',
      { id: ordersApi.id },
      'refused',
      {
        permission: 'app:delete',
      },
    ),
  ];
}
