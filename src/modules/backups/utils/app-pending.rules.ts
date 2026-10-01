import type {
  ProtectedAppOutcome,
  ProtectedAppOutcomeKind,
} from '../entities/backup-cluster-protection.entity';

export type AppPendingOutcome = Extract<
  ProtectedAppOutcomeKind,
  'waiting' | 'failed' | 'needs_decision'
>;

/** Why the cluster protection has not protected an application yet. */
export interface AppPending {
  outcome: AppPendingOutcome;
  reason: string | null;
  at: string;
  /** Whether creating its policy by hand would protect it now. */
  protectHelps: boolean;
}

const UNSETTLED = new Set<ProtectedAppOutcomeKind>([
  'waiting',
  'failed',
  'needs_decision',
]);

/**
 * The last pass's word on an application, while it still explains a gap.
 * `waiting` only ever means the database was not running: once it runs, the
 * next pass protects it and the old word would mislead.
 */
export function pendingOf(
  outcome: ProtectedAppOutcome | undefined,
  running: boolean,
): AppPending | null {
  if (!outcome || !UNSETTLED.has(outcome.outcome)) return null;
  if (outcome.outcome === 'waiting' && running) return null;
  return {
    outcome: outcome.outcome as AppPendingOutcome,
    reason: outcome.reason ?? null,
    at: outcome.at,
    protectHelps: outcome.outcome === 'failed' || outcome.outcome === 'skipped',
  };
}

export function applicationPath(applicationId: string): string {
  return `/apps/applications/${applicationId}`;
}

/** The application's Backup tab, where its protection is decided. */
export function appBackupsPath(applicationId: string): string {
  return `${applicationPath(applicationId)}/snapshots`;
}
