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
  PROJECTS: 'projects',
  ACCESS: 'access',
  SETTINGS: 'settings',
} as const;

export type SectionKey = (typeof SECTION)[keyof typeof SECTION];

type SectionGate =
  | { kind: 'always' }
  | { kind: 'permission'; permission: IamPermission; scope: 'global' | 'any' };

export interface SectionDef {
  key: SectionKey;
  gate: SectionGate;
}

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
  },
  {
    key: SECTION.INFRASTRUCTURE,
    gate: {
      kind: 'permission',
      permission: IAM_PERMISSION.CLUSTER_MANAGE,
      scope: 'global',
    },
  },
  {
    key: SECTION.FIREWALL,
    gate: {
      kind: 'permission',
      permission: IAM_PERMISSION.CLUSTER_MANAGE,
      scope: 'global',
    },
  },
  {
    key: SECTION.PROVIDERS,
    gate: {
      kind: 'permission',
      permission: IAM_PERMISSION.CLUSTER_MANAGE,
      scope: 'global',
    },
  },
  {
    key: SECTION.BACKUP,
    gate: {
      kind: 'permission',
      permission: IAM_PERMISSION.CLUSTER_MANAGE,
      scope: 'global',
    },
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
  },
];

export const ALL_SECTION_KEYS: SectionKey[] = SECTIONS.map((s) => s.key);
