/**
 * What a grant request adds to its own sentence.
 *
 * `POST /iam/grants` carries no route parameter at all: the role, who receives
 * it and how far it reaches all arrive in the body, so a person answering
 * "grant somebody a role on this instance" was shown the verb and none of the
 * blast radius. Pure, fed an unvalidated body and read once — a clause may be
 * nothing else, see `SentenceClause`.
 */
export function grantClauseOf(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  const role = text(b.role);
  const who = text(b.principalRef);
  if (!role || !who) return undefined;
  const kind = text(b.principalType)?.replaceAll('_', ' ') ?? 'principal';
  return `${role} to ${kind} ${who}, ${reachOf(b)}`;
}

/**
 * Unknown or missing scope reads as the widest one, not as an omission: the
 * body is unvalidated here, and a sentence that understates the reach is the
 * one failure this clause must not have.
 */
function reachOf(b: Record<string, unknown>): string {
  const scopeType = text(b.scopeType);
  const scopeRef = text(b.scopeRef);
  if (scopeType === 'section' && scopeRef) {
    return `over the ${scopeRef} section`;
  }
  if (scopeType === 'cluster' && scopeRef) {
    return `over cluster ${scopeRef}`;
  }
  if (scopeType === 'selector') {
    return 'over every application a standing rule matches, including ones deployed later';
  }
  return 'over the whole instance';
}

/**
 * Whatever was posted lands verbatim in a sentence a person reads and a
 * concession may keep for good, so it is flattened to one line and cut short —
 * a principal named across three lines is a principal that hides the rest of
 * the question.
 */
function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const flat = value.replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}
