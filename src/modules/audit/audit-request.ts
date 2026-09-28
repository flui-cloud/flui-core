/**
 * What the guards learn about a request that the audit record needs, left on
 * the request because the guards run after the audit middleware has attached
 * itself and before the response it waits for.
 */
export const AUDIT_PERMISSION = Symbol('audit.permission');
export const AUDIT_DATA_ACCESS = Symbol('audit.dataAccess');

export interface AuditableRequest {
  [AUDIT_PERMISSION]?: string;
  [AUDIT_DATA_ACCESS]?: boolean;
}

export function noteAuditPermission(req: object, permission: string): void {
  (req as AuditableRequest)[AUDIT_PERMISSION] = permission;
}

export function noteDataAccess(req: object): void {
  (req as AuditableRequest)[AUDIT_DATA_ACCESS] = true;
}
