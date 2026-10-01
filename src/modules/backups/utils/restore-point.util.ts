import { RestorePointMark } from '../services/continuous-backup-engine.interface';

export const RESTORE_POINT_MARKER = 'FLUI_RESTORE_POINT=';

/** What `manifestSummary.kind` says of a restore point: a moment, not a backup of its own. */
export const RESTORE_POINT_KIND = 'restore-point';

/** A restore point name a database accepts inside a quoted literal: letters, digits and dashes. */
export function restorePointLabel(deployId: string): string {
  const tail = deployId
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/g, '')
    .slice(0, 36);
  return `flui-before-deploy-${tail || 'unknown'}`;
}

/**
 * Reads `FLUI_RESTORE_POINT=<epoch ms> [position]` from an engine's output.
 * Throws when it is missing: a restore point that was not recorded must not be
 * reported as one.
 */
export function parseRestorePoint(out: string): RestorePointMark {
  const line = out
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith(RESTORE_POINT_MARKER));
  const [epoch, position] = (line?.slice(RESTORE_POINT_MARKER.length) ?? '')
    .trim()
    .split(/\s+/);
  const ms = Number(epoch);
  if (!line || !epoch || !Number.isFinite(ms) || ms <= 0) {
    throw new Error('The database did not report a restore point.');
  }
  return {
    at: new Date(ms).toISOString(),
    ...(position ? { position } : {}),
  };
}
