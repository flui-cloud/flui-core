import { Injectable, Logger } from '@nestjs/common';

export type SystemDbAuditResult = 'allow' | 'deny';
export type SystemDbAuditReason =
  | 'credential_ceiling'
  | 'not_platform_authority'
  | 'unknown_foundation'
  | 'control_cluster_absent'
  | null;

export interface SystemDbAuditEvent {
  type: 'system_db.access';
  ts: string;
  result: SystemDbAuditResult;
  reason: SystemDbAuditReason;
  /** The key that was asked for, whatever it was — an unknown one is the interesting case. */
  foundationKey?: string;
  userId?: string;
  clusterId?: string;
}

/**
 * Structured audit over the one road onto the platform's own database.
 *
 * The console audits queries and not `connection-info`, which is defensible
 * there: the coordinates it hands out are for a database the caller already
 * owns. Here they are not. Nobody is meant to walk this road often, and a road
 * nobody walks is exactly the one where a single entry has to be visible
 * afterwards — so the grant is recorded, and so is every refusal, including the
 * probe for a key that names nothing.
 *
 * Sink is the logger, and the event shape is kept stable so it can be persisted
 * later without touching call sites — same approach as
 * {@link InternalAppAuditService}, whose `result`/`reason` pair this borrows.
 */
@Injectable()
export class SystemDbAuditService {
  private readonly logger = new Logger('SystemDbAccess');

  emit(event: Omit<SystemDbAuditEvent, 'type' | 'ts'>): void {
    const payload: SystemDbAuditEvent = {
      type: 'system_db.access',
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
