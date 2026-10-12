import { Injectable, Logger } from '@nestjs/common';
import { DbConnectionRole } from '../interfaces/db-connection';

export interface DbConsoleAuditEvent {
  type: 'db_console.query';
  ts: string;
  dbInstallId: string;
  userId?: string;
  role: DbConnectionRole;
  command: string;
  rowCount: number;
  readOnly: boolean;
  durationMs: number;
  failed: boolean;
}

export interface DbSessionActionEvent {
  type: 'db_console.session_action';
  ts: string;
  dbInstallId: string;
  userId?: string;
  action: 'cancel' | 'terminate' | 'close_pooled_client';
  /** Backend pid for a session, client id for a pooled client. */
  pid: number;
  pod?: string;
  outcome: 'signalled' | 'gone' | 'failed';
}

/**
 * Structured audit for every query run through the console. Sink is the logger
 * today; the event shape is kept stable so it can be persisted to a table later
 * without touching call sites (same approach as InternalAppAuditService).
 */
@Injectable()
export class DbConsoleAuditService {
  private readonly logger = new Logger('DbConsoleAudit');

  emit(event: Omit<DbConsoleAuditEvent, 'type' | 'ts'>): void {
    const payload: DbConsoleAuditEvent = {
      type: 'db_console.query',
      ts: new Date().toISOString(),
      ...event,
    };
    if (event.failed) {
      this.logger.warn(payload);
    } else {
      this.logger.log(payload);
    }
  }

  /** Never the statement: pid, action and outcome are what a reviewer needs. */
  emitSessionAction(event: Omit<DbSessionActionEvent, 'type' | 'ts'>): void {
    const payload: DbSessionActionEvent = {
      type: 'db_console.session_action',
      ts: new Date().toISOString(),
      ...event,
    };
    if (event.outcome === 'failed') {
      this.logger.warn(payload);
    } else {
      this.logger.log(payload);
    }
  }
}
