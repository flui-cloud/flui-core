export type DbRestoreMode = 'latest' | 'as-of-backup' | 'point-in-time';

export interface DbRestorePlan {
  mode: DbRestoreMode;
  recoveryTargetTime?: Date;
  restoreSet?: string;
  /** Why a requested moment became "everything archived", when it did. */
  note?: string;
}

/**
 * What a database restore replays, decided once for every engine.
 *
 * No moment and the newest backup means everything that reached the
 * repository — the promise of continuous backup — not the base alone. A moment
 * at or after the newest archived change is the same thing: nothing archived
 * happened after it, and asking a recovery to stop at a moment it never meets
 * is an error for Postgres rather than "the end". Only a backup chosen on
 * purpose that is not the newest means that backup as it stood.
 */
export function planDbRestore(input: {
  requestedTarget: Date | null;
  artifactEngineRef: string | null;
  artifactIsNewest: boolean;
  newestArchived: Date | null;
  /** The repository was read and holds no change after its bases. */
  noChangesArchived: boolean;
  replaysToEndWithoutTarget: boolean;
  now: Date;
}): DbRestorePlan {
  const latest = (note?: string): DbRestorePlan => {
    if (input.replaysToEndWithoutTarget) return { mode: 'latest', note };
    if (input.noChangesArchived && input.artifactEngineRef) {
      return { mode: 'latest', restoreSet: input.artifactEngineRef, note };
    }
    return { mode: 'latest', recoveryTargetTime: input.now, note };
  };

  const target = input.requestedTarget;
  if (target) {
    if (input.newestArchived && target >= input.newestArchived) {
      return latest(
        `nothing reached the repository after ${input.newestArchived.toISOString()}, ` +
          `so ${target.toISOString()} is everything archived`,
      );
    }
    return { mode: 'point-in-time', recoveryTargetTime: target };
  }
  if (input.artifactIsNewest || !input.artifactEngineRef) return latest();
  return { mode: 'as-of-backup', restoreSet: input.artifactEngineRef };
}
