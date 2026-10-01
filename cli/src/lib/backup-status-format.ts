export interface CoverageApp {
  name: string;
  slug?: string;
  clusterName: string | null;
  reason: string;
  pending?: { reason: string | null } | null;
}

export interface DecidedApp extends CoverageApp {
  decision?: {
    note?: string;
    decidedByName?: string;
    decidedAt: string;
  } | null;
}

export interface AlertItem {
  id: string;
  name: string;
}

const COVERAGE_REASON: Record<string, string> = {
  no_policy: 'no policy covers it',
  no_schedule: 'its policy has no schedule',
  never_succeeded: 'no backup has succeeded yet',
  left_out: 'the last backup left its volumes out',
  stale: 'last backup is older than two scheduled runs',
  awaiting_first_run: 'waiting for the first scheduled run',
};

/** The app's name, its slug when that differs, and where it runs. */
export function coverageAppLabel(app: CoverageApp): string {
  const slug = app.slug && app.slug !== app.name ? ` (${app.slug})` : '';
  const where = app.clusterName ? ` on ${app.clusterName}` : '';
  return `${app.name}${slug}${where}`;
}

/** Why it is not protected: what protecting its cluster ran into, when it tried. */
export function coverageAppReason(app: CoverageApp): string {
  return app.pending?.reason ?? COVERAGE_REASON[app.reason] ?? app.reason;
}

export function alertItemLines(items: AlertItem[] | undefined): string[] {
  return (items ?? []).map((i) => `${i.name}  ${i.id}`);
}

/** Who decided an application is not backed up, when, and why. */
export function decisionLine(app: DecidedApp): string {
  const d = app.decision;
  if (!d) return 'not backed up by choice';
  const who = d.decidedByName ? ` by ${d.decidedByName}` : '';
  const when = ` on ${d.decidedAt.slice(0, 10)}`;
  const note = d.note ? `: ${d.note}` : '';
  return `not backed up by choice${who}${when}${note}`;
}
