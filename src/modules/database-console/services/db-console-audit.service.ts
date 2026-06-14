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
}
