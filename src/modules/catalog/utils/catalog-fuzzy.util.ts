/**
 * Tolerant catalog matching for the MCP/agent tools. The DB search is a single
 * substring LIKE, so "Flui Live Activity app" misses "Flui Live Activity (demo)"
 * and a guessed slug never matches a reordered real one. Ranks candidates by
 * token overlap + edit distance. Pure and dependency-free.
 */

export interface FuzzyCandidate {
  slug: string;
  name: string;
  description?: string;
  tags?: string[];
  alternativeTo?: string[];
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

function similarity(a: string, b: string): number {
  if (!a.length && !b.length) return 1;
  const longer = Math.max(a.length, b.length);
  return 1 - levenshtein(a, b) / longer;
}

export function scoreCandidate(query: string, c: FuzzyCandidate): number {
  const qTokens = tokenize(query);
  if (!qTokens.length) return 0;

  const haystack = new Set<string>([
    ...tokenize(c.name),
    ...tokenize(c.slug),
    ...(c.tags ?? []).flatMap(tokenize),
    ...(c.alternativeTo ?? []).flatMap(tokenize),
  ]);

  let matched = 0;
  for (const qt of qTokens) {
    if (haystack.has(qt)) {
      matched += 1;
      continue;
    }
    // Typo-level near match so "postgre" still counts against "postgresql".
    let best = 0;
    for (const ht of haystack) {
      const sim = similarity(qt, ht);
      if (sim > best) best = sim;
    }
    if (best >= 0.8) matched += best;
  }
  const tokenScore = matched / qTokens.length;

  // Whole-string similarity rescues short single-word queries (token overlap is brittle there).
  const q = query.toLowerCase();
  const strScore = Math.max(
    similarity(q, c.name.toLowerCase()),
    similarity(q.replace(/\s+/g, '-'), c.slug.toLowerCase()),
  );

  return Math.max(tokenScore, strScore * 0.9);
}

export function rankBySimilarity<T extends FuzzyCandidate>(
  query: string,
  candidates: T[],
  limit = 5,
  threshold = 0.3,
): T[] {
  return candidates
    .map((c) => ({ c, score: scoreCandidate(query, c) }))
    .filter((x) => x.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.c);
}
