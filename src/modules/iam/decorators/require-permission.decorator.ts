import { SetMetadata } from '@nestjs/common';

export const REQUIRED_PERMISSION_KEY = 'iam:requiredPermission';

/**
 * Gate a route on a single IAM permission. Enforced by the global
 * PermissionsGuard (default-deny when present; pass-through when absent).
 */
export const RequirePermission = (permission: string) =>
  SetMetadata(REQUIRED_PERMISSION_KEY, permission);
