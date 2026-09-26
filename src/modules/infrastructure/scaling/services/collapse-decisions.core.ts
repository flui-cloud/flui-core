interface Collapsible {
  at: string;
  force: string;
  outcome: string;
  why: string;
  asks: string | null;
  shape: string | null;
  region: string | null;
  operation: unknown;
  groupId?: string;
  repeats?: number;
  since?: string;
}

/**
 * The same decision taken minute after minute is one fact that lasted, not
 * sixty. Rows arrive newest first; a run of identical ones becomes its newest
 * row, counted, with the time the run began. A row that started an operation
 * always stands alone: it did something.
 */
export function collapseRepeats<T extends Collapsible>(rows: T[]): T[] {
  const out: T[] = [];
  for (const row of rows) {
    const head = out.at(-1);
    if (head && sameDecision(head, row)) {
      head.repeats = (head.repeats ?? 1) + 1;
      head.since = row.at;
      continue;
    }
    out.push({ ...row, repeats: 1 });
  }
  return out;
}

function sameDecision(a: Collapsible, b: Collapsible): boolean {
  return (
    !a.operation &&
    !b.operation &&
    a.force === b.force &&
    a.outcome === b.outcome &&
    a.why === b.why &&
    (a.asks ?? null) === (b.asks ?? null) &&
    (a.shape ?? null) === (b.shape ?? null) &&
    (a.region ?? null) === (b.region ?? null) &&
    (a.groupId ?? null) === (b.groupId ?? null)
  );
}
