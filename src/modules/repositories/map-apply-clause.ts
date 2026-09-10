/**
 * What an apply adds to its own sentence.
 *
 * The route parameter says *which repository*, and that is the thing being
 * acted on. What it does not say is the two choices the body makes and a
 * person would want in front of them before conceding anything: which branch
 * is read and cut from, and whether this is the whole map or a few named units
 * of it.
 *
 * The identity is deliberately NOT taken from here. The body is unvalidated at
 * the gate and the sentence it feeds is stored verbatim on the concession, so a
 * repository name read out of the body would be a sentence the caller writes —
 * approve `acme/shop`, act on something else. Resolving `{id}` into a name is
 * the decision page's job, with the reader's own credential; the gate says only
 * what the request itself decided.
 */
export function mapApplyClause(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as { branch?: unknown; unitIds?: unknown };
  const branch = text(b.branch);
  const units = unitList(b.unitIds);
  const read = branch ? `reading branch ${branch}` : undefined;
  const which = units ? `only ${units}` : undefined;
  const parts = [read, which].filter(Boolean);
  return parts.length ? parts.join(', ') : undefined;
}

/** At most three names, so the sentence stays a sentence. */
function unitList(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const names = value.map(text).filter((name): name is string => !!name);
  if (names.length === 0) return undefined;
  const shown = names.slice(0, 3).join(', ');
  return names.length > 3
    ? `${shown} and ${names.length - 3} more`
    : `${shown}`;
}

/**
 * The body is whatever was posted and the sentence it feeds is stored verbatim,
 * so it is flattened to one line and cut short rather than trusted.
 */
function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const flat = value.replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}
