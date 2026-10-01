const DAY_MS = 86_400_000;

/** What one platform run writes; a run missing either cannot rebuild Flui. */
export const PLATFORM_RUN_PARTS = ['platform:db', 'platform:keys'] as const;

interface PlatformRow {
  backupJobId: string;
  engineRef?: string | null;
  createdAt: Date | string;
}

/**
 * The run whose rows the sweeper may never delete: the newest one holding
 * every part, or the newest run at all when none is whole yet.
 *
 * Counted in runs because each run writes a row per part: a floor of "more
 * than one row left" was met by the two halves of a single run, and the last
 * platform backup could be pruned.
 */
export function newestCompletePlatformRun(
  rows: readonly PlatformRow[],
): string | null {
  const parts = new Map<string, Set<string>>();
  const newestFirst = [...rows].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  for (const row of newestFirst) {
    const set = parts.get(row.backupJobId) ?? new Set<string>();
    if (row.engineRef) set.add(row.engineRef);
    parts.set(row.backupJobId, set);
  }
  for (const [jobId, refs] of parts) {
    if (PLATFORM_RUN_PARTS.every((p) => refs.has(p))) return jobId;
  }
  return parts.keys().next().value ?? null;
}

interface DumpRow {
  createdAt: Date | string;
}

/**
 * Dumps past the policy's window, oldest first. Each dump is a whole, so they
 * age out by days like a copy; `retentionMaxCopies`, when set, caps how many
 * the window may hold. The newest is never among them.
 */
export function dumpsBeyondRetention<T extends DumpRow>(
  rows: readonly T[],
  policy: {
    retentionDays?: number | null;
    retentionMaxCopies?: number | null;
  },
  now: Date,
): T[] {
  const cutoff =
    now.getTime() - Math.max(1, policy.retentionDays ?? 30) * DAY_MS;
  const cap = policy.retentionMaxCopies
    ? Math.max(1, policy.retentionMaxCopies)
    : Number.POSITIVE_INFINITY;
  const newestFirst = [...rows].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  return newestFirst
    .filter(
      (row, i) =>
        i > 0 && (i >= cap || new Date(row.createdAt).getTime() < cutoff),
    )
    .reverse();
}
