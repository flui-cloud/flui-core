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
  mark,
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
