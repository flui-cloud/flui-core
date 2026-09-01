/**
 * What a manifest deploy adds to its own sentence.
 *
 * `POST /applications/deploy-from-yaml` has no route parameter — the
 * application it creates or replaces is identified by the repository, the
 * branch and the release name in the body — so without this the person
 * deciding reads "deploy an application from a manifest" and cannot tell which
 * one. Pure, fed an unvalidated body and read once.
 */
export function deployFromYamlClause(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as { repoFullName?: unknown; branch?: unknown } & {
    overrides?: { name?: unknown } | null;
  };
  const repo = text(b.repoFullName);
  if (!repo) return undefined;
  const branch = text(b.branch);
  const name = text(b.overrides?.name);
  const from = branch ? `from ${repo} on branch ${branch}` : `from ${repo}`;
  return name ? `${name}, ${from}` : from;
}

/**
 * The same route asked to check a manifest and to act on nothing.
 *
 * `validateOnly` returns before the deploy touches anything — no workflow
 * committed, no build, no application created — and the tool description sends
 * a model here precisely to check a manifest "without deploying or needing a
 * repo". Read strictly: the body is unvalidated at the gate, `"true"` is not
 * `true`, and anything this cannot recognise stays a deploy.
 */
export function deployValidatesOnly(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  return (body as { validateOnly?: unknown }).validateOnly === true;
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
