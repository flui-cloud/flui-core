import { hostname } from 'node:os';

const APPLICATION_PREFIX = 'flui-api:';

/**
 * This copy of the API: its pod's name, and the process within it. Short
 * enough that Postgres keeps it whole in `application_name` (63 bytes), so the
 * name a copy writes down is the name its sessions show.
 */
export const API_INSTANCE_ID =
  `${process.env.HOSTNAME || hostname()}:${process.pid}`.slice(
    0,
    63 - APPLICATION_PREFIX.length,
  );

/**
 * What this copy calls itself on its database connections. A copy is alive
 * exactly as long as Postgres lists a session under this name, which is how
 * one copy tells whether work another one started still has an owner.
 */
export const API_APPLICATION_NAME =
  `${APPLICATION_PREFIX}${API_INSTANCE_ID}`.slice(0, 63);

export function instanceOfApplicationName(name: string): string | null {
  return name.startsWith(APPLICATION_PREFIX)
    ? name.slice(APPLICATION_PREFIX.length)
    : null;
}
