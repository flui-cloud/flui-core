import { Injectable, Logger } from '@nestjs/common';

export type InternalAppAuditResult = 'allow' | 'deny';
export type InternalAppAuditReason =
  | 'missing_forwarded_host'
  | 'app_not_found'
  | 'not_internal'
  | 'not_permitted'
  | 'session_invalid'
  | null;

export interface InternalAppAuditEvent {
  type: 'internal_app_access.authz';
  ts: string;
  result: InternalAppAuditResult;
  reason: InternalAppAuditReason;
  userId?: string;
  userEmail?: string;
  appId?: string;
  appSlug?: string;
  clusterId?: string;
  host?: string;
  method?: string;
  path?: string;
  clientIp?: string;
  userAgent?: string;
  latencyMs?: number;
}

/**
 * Emits structured audit events for every ForwardAuth decision on internal
 * apps. Today the sink is the application logger (structured JSON in
 * production via ConsoleLogger). A database table + retention policy is a
 * planned follow-up; the event shape is kept stable so we can persist it
 * later without touching call sites.
 */
@Injectable()
export class InternalAppAuditService {
  private readonly logger = new Logger('InternalAppAudit');

  emit(event: Omit<InternalAppAuditEvent, 'type' | 'ts'>): void {
    const payload: InternalAppAuditEvent = {
      type: 'internal_app_access.authz',
      ts: new Date().toISOString(),
      ...event,
    };
    if (event.result === 'deny') {
      this.logger.warn(payload);
    } else {
      this.logger.log(payload);
    }
  }
}
