import { IAM_PERMISSION, IamPermission } from './iam-permissions';

// Portal sections, derived scope-aware from the resolved access (never stored):
// a management section needs its permission at GLOBAL scope, a workload section
// at ANY scope. Same keys gate the API (@RequireSection) and the sidebar.
export const SECTION = {
  HOME: 'home',
  WORKLOADS: 'workloads',
  DEPLOY: 'deploy',
  CLUSTERS: 'clusters',
  INFRASTRUCTURE: 'infrastructure',
  FIREWALL: 'firewall',
  PROVIDERS: 'providers',
  BACKUP: 'backup',
  MAIL: 'mail',
  PROJECTS: 'projects',
  ACCESS: 'access',
  SETTINGS: 'settings',
} as const;

export type SectionKey = (typeof SECTION)[keyof typeof SECTION];

/**
 * How far into a section a principal gets.
 *
 * The model used to be binary — hold the governing permission at global scope
 * and see the whole section, or not see it at all — and that left no way to say
 * the thing a demonstration, and a read-only operator, both need: *visible, but
 * not yours to change*. `read-only` is that third state. It is enforced here and
 * in SectionAccessGuard, which lets only safe verbs through it; the interface
 * draws the same section with its controls disabled.
 */
export type SectionLevel = 'full' | 'read-only';

export interface SectionAccess {
  key: SectionKey;
  level: SectionLevel;
}

type SectionGate =
  | { kind: 'always' }
  | { kind: 'permission'; permission: IamPermission; scope: 'global' | 'any' };

export interface SectionDef {
  key: SectionKey;
  /** Opens the section at `full`. */
  gate: SectionGate;
  /**
   * Opens the same section at `read-only`, when `gate` does not open it.
   *
   * Deliberately one key for every section rather than a read-only twin of each
   * governing permission: it is a level, not a subject. What it may *reach* is
   * still decided per route — the guard behind it refuses writes, and for a
   * sandbox guest the fence refuses every route this list does not name.
   *
   * Two of these sections — mail and access — answer with other people's
   * personal data when the handler actually runs. A guest never reaches that
   * handler (they are answered from the example world instead), so granting
   * `section:view` to a *human* role would be a wider door than it looks:
   * those routes carry no per-tenant projection yet. Until they do, no built-in
   * role but `sandbox` carries this permission.
   */
  view?: SectionGate;
}

const READ_ONLY_ENTRY: SectionGate = {
  kind: 'permission',
  permission: IAM_PERMISSION.SECTION_VIEW,
  scope: 'any',
};

export const SECTIONS: SectionDef[] = [
  { key: SECTION.HOME, gate: { kind: 'always' } },
  { key: SECTION.SETTINGS, gate: { kind: 'always' } },
  // Workload/deploy: a SCOPED app grant is enough — you operate the apps you reach.
  {
    key: SECTION.WORKLOADS,
    gate: {
      kind: 'permission',
      permission: IAM_PERMISSION.APP_READ,
      scope: 'any',
    },
  },
  {
    key: SECTION.DEPLOY,
    gate: {
      kind: 'permission',
      permission: IAM_PERMISSION.APP_CREATE,
      scope: 'any',
    },
  },
  // Management plane: governing permission must be held at GLOBAL scope.
  {
    key: SECTION.CLUSTERS,
    gate: {
      kind: 'permission',
      permission: IAM_PERMISSION.CLUSTER_READ,
      scope: 'global',
    },
    view: READ_ONLY_ENTRY,
  },
  {
    key: SECTION.INFRASTRUCTURE,
    gate: {
      kind: 'permission',
      permission: IAM_PERMISSION.CLUSTER_MANAGE,
      scope: 'global',
    },
    view: READ_ONLY_ENTRY,
  },
  {
    key: SECTION.FIREWALL,
    gate: {
      kind: 'permission',
      permission: IAM_PERMISSION.CLUSTER_MANAGE,
      scope: 'global',
    },
    view: READ_ONLY_ENTRY,
  },
  {
    key: SECTION.PROVIDERS,
    gate: {
      kind: 'permission',
      permission: IAM_PERMISSION.CLUSTER_MANAGE,
      scope: 'global',
    },
    view: READ_ONLY_ENTRY,
  },
  {
    key: SECTION.BACKUP,
    gate: {
      kind: 'permission',
      permission: IAM_PERMISSION.CLUSTER_MANAGE,
      scope: 'global',
    },
    view: READ_ONLY_ENTRY,
  },
  // Mail sits with the other platform-admin sections rather than getting a
  // permission of its own. It shows recipient addresses — other people's
  // personal data — so the bar should not be lower than this; global cluster
  // management is already a narrow enough set that it is not a wider door than
  // the credentials and DNS zones the same holder can already reach.
  {
    key: SECTION.MAIL,
    gate: {
      kind: 'permission',
      permission: IAM_PERMISSION.CLUSTER_MANAGE,
      scope: 'global',
    },
    view: READ_ONLY_ENTRY,
  },
  {
    key: SECTION.PROJECTS,
    gate: {
      kind: 'permission',
      permission: IAM_PERMISSION.IAM_ASSIGN_ROLE,
      scope: 'global',
    },
  },
  {
    key: SECTION.ACCESS,
    gate: {
      kind: 'permission',
      permission: IAM_PERMISSION.IAM_ASSIGN_ROLE,
      scope: 'global',
    },
    view: READ_ONLY_ENTRY,
  },
];

export const ALL_SECTION_KEYS: SectionKey[] = SECTIONS.map((s) => s.key);

/**
 * Verbs a `read-only` section lets through. HEAD and OPTIONS are here because a
 * browser sends them on its own; refusing them would break a section the level
 * is meant to open.
 */
const SAFE_VERBS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isSafeVerb(method: string | undefined): boolean {
  return SAFE_VERBS.has((method ?? '').toUpperCase());
}
