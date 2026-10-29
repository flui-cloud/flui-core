import { DatabaseHaSpec } from '../postgres-ha.types';

interface AppLike {
  labels?: Record<string, string> | null;
  workloadKind?: string | null;
  imageRef?: string | null;
  sourceConfig?: unknown;
  databaseHa?: DatabaseHaSpec | null;
  pooler?: { enabled?: boolean; upstream?: { mode?: string } } | null;
}

export type HaEligibility =
  | { eligible: true }
  | { eligible: false; reason: string };

/**
 * Which databases can move to a highly available cluster today: Flui's own
 * Postgres, the one whose image, roles and access rules the move was proven
 * on. A database that is moving somewhere else, or already moved, is refused.
 */
export function postgresHaEligibility(
  app: AppLike,
  /** False when no activation is queued or running: a `copying` state is then what a stopped attempt left. */
  activationRunning = true,
): HaEligibility {
  if (app.labels?.['flui.cloud/db-engine'] !== 'postgres') {
    return {
      eligible: false,
      reason: 'Only a PostgreSQL database can be made highly available.',
    };
  }
  const image =
    app.imageRef ??
    (app.sourceConfig as { imageRef?: string } | undefined)?.imageRef ??
    '';
  if (app.workloadKind !== 'StatefulSet' || !/\/flui-postgres:/.test(image)) {
    return {
      eligible: false,
      reason:
        "Only Flui's own PostgreSQL can be made highly available for now; this one runs another image.",
    };
  }
  if (app.databaseHa?.state === 'active') {
    return {
      eligible: false,
      reason: 'This database is already highly available.',
    };
  }
  if (app.databaseHa?.state === 'copying' && activationRunning) {
    return {
      eligible: false,
      reason: 'This database is already being made highly available.',
    };
  }
  if (app.pooler?.enabled && app.pooler.upstream?.mode === 'forward') {
    return {
      eligible: false,
      reason:
        'This database is being moved to another cluster; finish that first.',
    };
  }
  return { eligible: true };
}
