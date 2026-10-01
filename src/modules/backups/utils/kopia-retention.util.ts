/**
 * How many snapshots of a volume kopia keeps, and how the ledger follows it.
 *
 * kopia applies retention itself, per source, every time a snapshot is taken:
 * seven days and four weeks by default, three months when a policy opts in.
 * The ledger mirrors what kopia still lists rather than computing an expiry of
 * its own — a date computed on the side would disagree with the repository the
 * day either rule changed, and the repository is the one that decides.
 */
export interface KopiaRetention {
  keepLatest: number;
  keepHourly: number;
  keepDaily: number;
  keepWeekly: number;
  keepMonthly: number;
  keepAnnual: number;
}

export const DEFAULT_KOPIA_RETENTION: Readonly<KopiaRetention> = {
  keepLatest: 1,
  keepHourly: 0,
  keepDaily: 7,
  keepWeekly: 4,
  keepMonthly: 0,
  keepAnnual: 0,
};

/** What the monthly opt-in keeps. */
export const KOPIA_OPT_IN_MONTHLY = 3;

const MAX_KEEP = 366;

function count(value: unknown, fallback: number, min = 0): number {
  const n = Number(value);
  if (value === undefined || value === null || !Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(MAX_KEEP, Math.max(min, Math.floor(n)));
}

/**
 * A policy's retention for kopia, from what a person may set on it.
 *
 * `keepMonthly: true` is the opt-in to the monthly tier; a number sets it
 * exactly. The latest snapshot is always kept, whatever the numbers say: a
 * retention that could empty itself is indistinguishable from no backup.
 */
export function kopiaRetentionFor(
  metadata?: Record<string, unknown> | null,
): KopiaRetention {
  const monthly = metadata?.keepMonthly;
  return {
    keepLatest: count(
      metadata?.keepLatest,
      DEFAULT_KOPIA_RETENTION.keepLatest,
      1,
    ),
    keepHourly: 0,
    keepDaily: count(metadata?.keepDaily, DEFAULT_KOPIA_RETENTION.keepDaily),
    keepWeekly: count(metadata?.keepWeekly, DEFAULT_KOPIA_RETENTION.keepWeekly),
    keepMonthly:
      monthly === true
        ? KOPIA_OPT_IN_MONTHLY
        : count(monthly, DEFAULT_KOPIA_RETENTION.keepMonthly),
    keepAnnual: 0,
  };
}

/** `kopia policy set --global` arguments for a retention. */
export function kopiaRetentionArgs(r: KopiaRetention): string[] {
  return [
    `--keep-latest=${Math.max(1, r.keepLatest)}`,
    `--keep-hourly=${r.keepHourly}`,
    `--keep-daily=${r.keepDaily}`,
    `--keep-weekly=${r.keepWeekly}`,
    `--keep-monthly=${r.keepMonthly}`,
    `--keep-annual=${r.keepAnnual}`,
  ];
}

/** In words, for the CLI and the dashboard. */
export function describeKopiaRetention(r: KopiaRetention): string {
  const parts = [
    r.keepDaily ? `${r.keepDaily} daily` : '',
    r.keepWeekly ? `${r.keepWeekly} weekly` : '',
    r.keepMonthly ? `${r.keepMonthly} monthly` : '',
  ].filter(Boolean);
  return parts.length
    ? `${parts.join(' + ')} (the latest always kept)`
    : 'the latest only';
}

/** One snapshot as `kopia snapshot list --json` prints it. */
export interface KopiaListedSnapshot {
  id: string;
  source?: { host?: string; userName?: string; path?: string };
  startTime?: string;
  endTime?: string;
  pins?: string[];
  retentionReason?: string[];
  stats?: { totalSize?: number; fileCount?: number };
  rootEntry?: {
    obj?: string;
    summ?: { size?: number; files?: number; numFailed?: number };
  };
}

/** `user@host:/path`, the way kopia names a source. */
export function kopiaSourceString(s: KopiaListedSnapshot): string {
  return `${s.source?.userName ?? ''}@${s.source?.host ?? ''}:${s.source?.path ?? ''}`;
}

export interface LedgerSnapshotRef {
  artifactId: string;
  snapshotId: string;
  /** The kopia source the snapshot was recorded under. */
  source?: string;
  /** The SQLite overlay taken with it, when there was one. */
  sqliteSnapshotId?: string;
  /** Rows already marked gone are not reported twice. */
  gone?: boolean;
}

/**
 * Ledger rows whose snapshot kopia no longer lists.
 *
 * Only rows of the sources the listing covered are judged: an ad-hoc snapshot
 * of the same volume lives under a source of its own and is absent from the
 * schedule's listing because it was never in it, not because it expired. A
 * row whose source is unknown is never judged. An empty listing judges nothing — "kopia answered with nothing" and
 * "the listing failed" look the same from here, and reading the second as the
 * first would mark every backup of the volume gone.
 */
export function snapshotsGone(
  rows: ReadonlyArray<LedgerSnapshotRef>,
  listed: ReadonlyArray<KopiaListedSnapshot>,
): string[] {
  if (listed.length === 0) return [];
  const present = new Set(listed.map((s) => s.id));
  const sources = new Set(listed.map(kopiaSourceString));
  return rows
    .filter(
      (r) =>
        !r.gone &&
        !!r.source &&
        sources.has(r.source) &&
        !present.has(r.snapshotId),
    )
    .map((r) => r.artifactId);
}

/** A monthly spot check of a few percent of the files, read back and decrypted. */
export const KOPIA_VERIFY_EVERY_DAYS = 30;
export const KOPIA_VERIFY_PERCENT = 2;

export function kopiaVerifyDue(
  lastVerifiedAt: Date | string | null | undefined,
  now: Date,
): boolean {
  if (!lastVerifiedAt) return true;
  const last = new Date(lastVerifiedAt);
  if (Number.isNaN(last.getTime())) return true;
  return now.getTime() - last.getTime() >= KOPIA_VERIFY_EVERY_DAYS * 86_400_000;
}

/** Full maintenance once a week; quick maintenance after every snapshot. */
export const KOPIA_FULL_MAINTENANCE_INTERVAL = '168h';
export const KOPIA_QUICK_MAINTENANCE_INTERVAL = '1h';
