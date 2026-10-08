import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';

export interface RedactedHeartbeat {
  set: true;
  host: string;
}

/**
 * The heartbeat address is a credential for the outside watchdog: whoever has
 * it can keep the watchdog quiet while the installation is down. A policy
 * leaves the API saying where its heartbeat goes, never the address itself.
 */
export function redactHeartbeat<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => redactHeartbeat(v)) as T;
  const platform = (
    value as { metadata?: { platform?: { heartbeat?: { url?: string } } } }
  )?.metadata?.platform;
  const url = platform?.heartbeat?.url;
  if (!url) return value;
  const heartbeat: RedactedHeartbeat = { set: true, host: hostOf(url) };
  return {
    ...value,
    metadata: {
      ...(value as { metadata: object }).metadata,
      platform: { ...platform, heartbeat },
    },
  } as T;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown';
  }
}

@Injectable()
export class HeartbeatRedactionInterceptor implements NestInterceptor {
  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    return next.handle().pipe(map((body) => redactHeartbeat(body)));
  }
}
