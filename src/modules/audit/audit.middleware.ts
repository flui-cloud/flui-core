import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { AuditService } from './audit.service';
import {
  AUDIT_DATA_ACCESS,
  AUDIT_PERMISSION,
  AuditableRequest,
} from './audit-request';
import { AuditOutcome } from './entities/audit-event.entity';
import { isSafeVerb } from '../iam/constants/iam-sections';
import { actorFromRequest } from '../auth/utils/actor.util';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

const API_PREFIX = /^\/api\/v1/;

export function outcomeOf(status: number): AuditOutcome {
  if (status === 401 || status === 403) return 'refused';
  return status >= 400 ? 'failed' : 'ok';
}

/**
 * Records a request once its response has gone, so the status is known and a
 * refusal by a guard is recorded like anything else. It decides only whether to
 * record; what the request was allowed to do was decided elsewhere.
 */
@Injectable()
export class AuditMiddleware implements NestMiddleware {
  constructor(private readonly audit: AuditService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    res.on('finish', () => {
      const entry = auditEntryFor(req, res.statusCode);
      if (entry) void this.audit.record(entry);
    });
    next();
  }
}

function paramEntries(req: Request): Array<[string, string | string[]]> {
  return Object.entries(req.params ?? {}) as Array<[string, string | string[]]>;
}

export function auditEntryFor(
  req: Request,
  status: number,
): Parameters<AuditService['record']>[0] | null {
  const user = req.user as AuthenticatedUser | undefined;
  const route = (req.route as { path?: string } | undefined)?.path;
  if (!user || !route) return null;

  const notes = req as unknown as AuditableRequest;
  const dataAccess = !!notes[AUDIT_DATA_ACCESS];
  const outcome = outcomeOf(status);
  if (isSafeVerb(req.method) && !dataAccess && outcome !== 'refused') {
    return null;
  }

  const actor = actorFromRequest(req as never);
  const target = Object.fromEntries(
    paramEntries(req).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v]),
  );
  return {
    userId: user.userId ?? null,
    email: user.email ?? null,
    actorKind: actor.kind,
    actorKeyId: actor.keyId ?? null,
    action: `${req.method} ${route.replace(API_PREFIX, '') || '/'}`,
    target: Object.keys(target).length ? target : null,
    status,
    outcome,
    permission: notes[AUDIT_PERMISSION] ?? null,
    dataAccess,
  };
}
