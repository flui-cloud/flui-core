/**
 * IAM permission catalog — atomic, flat keys (the unit a role bundles and an
 * endpoint requires). Mirrors the MCP scope-catalog style. Extend as needed.
 */
export const IAM_PERMISSION = {
  APP_READ: 'app:read',
  APP_WRITE: 'app:write',
  APP_DEPLOY: 'app:deploy',
  APP_CREATE: 'app:create',
  APP_DELETE: 'app:delete',
  SCALE_EXECUTE: 'scale:execute',
  MIGRATION_EXECUTE: 'migration:execute',
  CLUSTER_READ: 'cluster:read',
  CLUSTER_MANAGE: 'cluster:manage',
  BILLING_READ: 'billing:read',
  IAM_ASSIGN_ROLE: 'iam:assign-role',
} as const;

export type IamPermission =
  (typeof IAM_PERMISSION)[keyof typeof IAM_PERMISSION];

export const ALL_PERMISSIONS: IamPermission[] = Object.values(IAM_PERMISSION);
