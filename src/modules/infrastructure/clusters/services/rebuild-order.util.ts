/**
 * The order a rebuild brings applications back in: what others use first.
 *
 * A database restored after the application that uses it lets that
 * application boot against nothing — it runs its migrations into the empty
 * database the dump is then loaded over, or crashes and is reported failed
 * although a second run would have worked.
 */

export interface OrderableApp {
  id: string;
  name: string;
  slug: string;
  kind?: string | null;
  env?: Array<{
    name: string;
    value?: string | null;
    externalSecretRef?: { secretName: string; key: string } | null;
  }> | null;
  metadata?: Record<string, unknown> | null;
}

/** `before` must be back before `after` starts. */
export interface RebuildDependency {
  before: string;
  after: string;
  why: string;
}

/** A composed or dependent catalog install, as far as ordering needs it. */
export interface OrderableInstall {
  id: string;
  /** Written in the order the install created its components: dependencies first. */
  applicationIds: string[];
  dependencyInstallIds?: string[];
}

/** An application's attached building block, from `application_services`. */
export interface OrderableAttachment {
  applicationId: string;
  bbApplicationId: string | null;
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * Another application named as a host in a variable: `<slug>`, or the
 * composed form `<slug>-svc`, as a whole label — so `db` is not found inside
 * `my-db` or `dbx`.
 */
function mentions(value: string, slug: string): boolean {
  const pattern = new RegExp(
    `(?:^|[^a-z0-9-])${escapeRegExp(slug)}(?:-svc)?(?=$|[^a-z0-9-])`,
    'i',
  );
  return pattern.test(value);
}

type AddDependency = (before: string, after: string, why: string) => void;

function attachmentDependencies(
  attachments: OrderableAttachment[],
  add: AddDependency,
): void {
  for (const attachment of attachments) {
    if (attachment.bbApplicationId) {
      add(attachment.bbApplicationId, attachment.applicationId, 'attached');
    }
  }
}

function installDependencies(
  installs: OrderableInstall[],
  add: AddDependency,
): void {
  const appsOfInstall = new Map(
    installs.map((i) => [i.id, i.applicationIds ?? []]),
  );
  for (const install of installs) {
    const own = install.applicationIds ?? [];
    for (let i = 1; i < own.length; i++) add(own[i - 1], own[i], 'component');
    const before = (install.dependencyInstallIds ?? []).flatMap(
      (id) => appsOfInstall.get(id) ?? [],
    );
    for (const b of before) for (const a of own) add(b, a, 'install');
  }
}

function names(
  variable: NonNullable<OrderableApp['env']>[number],
  slug: string,
): boolean {
  if (variable.value && mentions(variable.value, slug)) return true;
  const secretName = variable.externalSecretRef?.secretName;
  return (
    !!secretName && (secretName === slug || secretName.startsWith(`${slug}-`))
  );
}

function variableDependencies(apps: OrderableApp[], add: AddDependency): void {
  for (const app of apps) {
    for (const other of apps) {
      if (other.id === app.id || !other.slug) continue;
      if ((app.env ?? []).some((v) => names(v, other.slug))) {
        add(other.id, app.id, 'variable');
      }
    }
  }
}

/** Every dependency the records state, among the applications being rebuilt. */
export function rebuildDependencies(
  apps: OrderableApp[],
  installs: OrderableInstall[] = [],
  attachments: OrderableAttachment[] = [],
): RebuildDependency[] {
  const ids = new Set(apps.map((a) => a.id));
  const deps: RebuildDependency[] = [];
  const add: AddDependency = (before, after, why) => {
    if (before === after || !ids.has(before) || !ids.has(after)) return;
    deps.push({ before, after, why });
  };
  attachmentDependencies(attachments, add);
  installDependencies(installs, add);
  variableDependencies(apps, add);
  return deps;
}

/** Databases before the rest, then by name — what is left once dependencies are met. */
function tieBreak(a: OrderableApp, b: OrderableApp): number {
  const rank = (x: OrderableApp) => (x.kind === 'DATABASE' ? 0 : 1);
  return rank(a) - rank(b) || a.name.localeCompare(b.name);
}

/**
 * A topological order, stable under the tie-break. A cycle cannot be ordered,
 * so its members follow the tie-break alone rather than stopping the rebuild.
 */
export function orderForRebuild<T extends OrderableApp>(
  apps: T[],
  deps: RebuildDependency[],
): T[] {
  const byId = new Map(apps.map((a) => [a.id, a]));
  const waitingOn = new Map<string, Set<string>>(
    apps.map((a) => [a.id, new Set<string>()]),
  );
  for (const dep of deps) {
    if (byId.has(dep.before) && byId.has(dep.after)) {
      waitingOn.get(dep.after)!.add(dep.before);
    }
  }

  const ordered: T[] = [];
  const done = new Set<string>();
  while (ordered.length < apps.length) {
    const ready = apps
      .filter((a) => !done.has(a.id))
      .filter((a) => [...waitingOn.get(a.id)!].every((d) => done.has(d)))
      .sort(tieBreak);
    const next =
      ready[0] ?? apps.filter((a) => !done.has(a.id)).sort(tieBreak)[0];
    ordered.push(next);
    done.add(next.id);
  }
  return ordered;
}

/** The names each application waits for, for the plan to show. */
export function waitsFor(
  apps: OrderableApp[],
  deps: RebuildDependency[],
): Map<string, string[]> {
  const names = new Map(apps.map((a) => [a.id, a.name]));
  const out = new Map<string, string[]>();
  for (const dep of deps) {
    const name = names.get(dep.before);
    if (!name || !names.has(dep.after)) continue;
    const list = out.get(dep.after) ?? [];
    if (!list.includes(name)) list.push(name);
    out.set(dep.after, list);
  }
  return out;
}
