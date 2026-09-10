/**
 * What only the repository can tell an author about their manifest.
 *
 * `manifest-checks.core.ts` answers "would this land *here*" — the cluster, the
 * credentials, the capacity. It never opens the code. That gap is measured: a
 * manifest naming a Dockerfile that does not exist, a context that does not
 * exist, and a port and a health path that were invented passed `valid: true`
 * with no warning, twice, from two different agents.
 *
 * These are more entries in the same `checks[]` list — same `ManifestCheck`,
 * same four statuses, same renderers in the CLI and the dashboard. Nothing new
 * is contracted, and nothing here can change what the seven installation checks
 * answer: they keep their own facts object and their own function.
 *
 * Three rules govern every status below, and they are the whole design:
 *
 * 1. `fail` ONLY when it is demonstrable — the listing is complete and the named
 *    file is not in it. Everything else costs someone a build that was going to
 *    work.
 * 2. `warn` for probable drift — a port, a health path, an undeclared key. The
 *    repository says one thing and the manifest another, and the author decides
 *    which is right.
 * 3. `unknown` when we could not look. This is the directus rule: if that
 *    framework's routes are not enumerable, the answer is "I could not check",
 *    never "your path is wrong". A false alarm on a health path that was
 *    correct all along costs more than silence, because it teaches an author to
 *    stop reading this list.
 *
 * The corollary that is easy to miss: **a truncated read cannot produce a
 * `fail`.** Absence only proves absence when the listing is whole.
 */

import {
  checksFor,
  type CheckStatus,
  type ManifestCheck,
  type ManifestFacts,
} from './manifest-checks.core';

export type { CheckStatus, ManifestCheck };

/**
 * Every id this family can emit. A closed union rather than `string` so a new
 * check cannot be added without appearing in the design, the tests and the
 * documentation at the same time.
 */
export type RepoCheckId =
  | 'repo-snapshot'
  | 'repo-dockerfile'
  | 'repo-build-context'
  | 'repo-port'
  | 'repo-health-path'
  | 'repo-env'
  | 'repo-services'
  | 'repo-units'
  | 'repo-blockers'
  | 'manifest-currency';

/**
 * A value and the line it was read from, `<file>:<line>`, carried verbatim from
 * the reader. Every warning below quotes one: an author asked to change a port
 * is owed the file that disagrees with them.
 */
export interface RepoEvidence<T> {
  value: T;
  source: string;
}

/* ────────────────────────────────────────────────────────────────────────────
 * What the manifest asserts.
 *
 * Flattened rather than handed the manifest itself, exactly as `ManifestFacts`
 * is: a pure comparison module that imports the manifest interface starts
 * answering questions about manifest shape, and this file must only ever
 * compare two sets of already-read facts.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface ManifestClaims {
  /** `build.dockerfile`, repository-relative. Null when the manifest names none. */
  dockerfilePath: string | null;
  /** `build.context`. Null means the repository root, which always exists. */
  buildContext: string | null;
  /** `build.strategy` as written. */
  buildStrategy: string | null;
  /** `deploy.port`. */
  port: number | null;
  /** `healthcheck.path`. */
  healthPath: string | null;
  /** Keys the manifest declares in `deploy.env`, under any of its forms. */
  declaredEnvKeys: string[];
  /**
   * Keys the manifest does not declare but will receive anyway: a service ref,
   * a `valueFrom`, an environment profile. Counted as supplied, so the env
   * check does not warn about a key the deploy will in fact set.
   */
  suppliedEnvKeys: string[];
  /**
   * What the manifest attaches or points at, by engine/kind (`postgres`,
   * `redis`, …), from `deploy.services` and from env that resolves to an
   * existing app.
   */
  providedServiceKinds: string[];
  /**
   * The subdirectory this manifest covers, from `build.context`/`subPath`.
   * Null means the whole repository. Used to say, without accusing, that a
   * repository holds units this manifest does not deploy.
   */
  unitPath: string | null;
}

/**
 * The manifest against the platform rather than against the code: the ageing
 * family. Needs no repository, so it answers on every validation, including one
 * with no repository attached at all.
 */
export interface ManifestShapeFacts {
  /** As written. `flui/v1` is legacy and still accepted. */
  apiVersion: string;
  /** The list form of `deploy.env` was marked deprecated in spec 0.9.0. */
  envForm: 'map' | 'list' | 'absent';
  /**
   * Field paths present in the manifest that this installation reads and then
   * does nothing with (`resources.profile`, `scaling`, `userEditable`,
   * `delivery`). The marker that says so lives in the JSON schema, which nobody
   * reads while writing a manifest — which is how a published manifest came to
   * declare a profile and a replica count that do nothing, for months, with
   * nobody told.
   */
  inertFields: string[];
  /**
   * What `build.strategy` will actually mean here. `auto` maps to Railpack on
   * this installation and is refused outright by vops, so the value is named
   * rather than echoed.
   */
  resolvedBuildStrategy: string | null;
}

export interface ManifestSelfFacts {
  claims: ManifestClaims;
  currency: ManifestShapeFacts;
}

/* ────────────────────────────────────────────────────────────────────────────
 * What the repository says.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Why the repository could not be read. Every one of these produces exactly one
 * `repo-snapshot: unknown` and no other repository check, because ten unknowns
 * in a row teach a reader to skip the whole list.
 */
export type RepoUnreadReason =
  /** A repository was named but is not connected to this account. */
  | 'not-connected'
  /** No credential in this account can read it. */
  | 'no-credential'
  /** The repository or the ref does not exist, or this credential cannot see it. */
  | 'not-found'
  /** The archive passed the byte ceiling before a usable listing came out of it. */
  | 'too-large'
  /** Network, decompression or archive error. */
  | 'unreadable'
  /** The archive carried a path that escapes its own root: refused whole, not narrowed. */
  | 'rejected';

/**
 * The edge of what was looked at, stated rather than implied.
 *
 * This is the half of the answer that makes `fail` safe: a check may only
 * conclude that a file is absent when `listingComplete` is true.
 */
export interface RepoReadBoundary {
  /** The commit every answer below is true of, and of no other tree. */
  commitSha: string;
  ref: string;
  /** Paths seen. */
  files: number;
  /** False when the walk stopped at a ceiling: absence then proves nothing. */
  listingComplete: boolean;
  /** Bytes of file content retained. */
  bytesRead: number;
  /** False when some listed files were never read: existence still answerable, content not. */
  contentComplete: boolean;
  /**
   * Entries the reader refused. Symlinks are refused on purpose and counted
   * here rather than passed over quietly — a repository is untrusted input, and
   * a reader that follows a link out of the tree reads the host.
   */
  skipped: { symlinks: number; oversize: number; other: number };
  /** What was searched for and not found, carried through verbatim from the reader. */
  notFound: string[];
  /**
   * A high-density path (`Dockerfile`, a compose file, a dependency manifest,
   * `schema.prisma`, …) the content ceiling cut. Retention is priority-ordered
   * so this is normally empty even when `contentComplete` is false; when it is
   * not, the gap is named rather than folded into the generic "not every file
   * was read" note.
   */
  highDensityUnread: string[];
}

/** A path the code serves, as read from the line that registers it. */
export interface RepoRoute {
  path: string;
  source: string;
  /**
   * The route is relative to a mount point that was not located, so the real
   * path is `<something>` + this. This is the directus case, and it is why a
   * route table containing one of these can never contradict a manifest: the
   * manifest may be naming the mounted path correctly.
   *
   * It is also why one of these can never *confirm* a manifest, which is the
   * half that was missing. cartographer widened the flag on 2026-09-08 from
   * "a JavaScript sub-router" to every mount it reads — a Spring class
   * `@RequestMapping`, a Nest application prefix, a Python `APIRouter`, a
   * Django `include` hop it cannot follow, a Laravel group. Before that, the
   * fragment came through as if it were the whole path: `repo-health-path`
   * answered `pass` on `/status` for `angular-grimmory` and `/ping` for
   * `spring-boot-scoold`, whose classes are mapped at `/api/v1/setup` and
   * `/api`. Both readings came from one `findRoutes` call, so the rendered
   * manifest and the check that approved it could not disagree.
   */
  prefixUnresolved?: true;
  /** The handler answers 4xx/5xx unconditionally: a real route, never a health path. */
  alwaysError?: true;
  /**
   * The path was never seen registered: it is what a dependency the repository
   * declares serves by default, and `source` cites the line that declares it —
   * `spring-boot-starter-actuator` in a `pom.xml`/`build.gradle.kts`. Still
   * evidence, and still enough to answer "is this path a thing here?", but
   * `repo-health-path` must not call it a route the code serves.
   */
  fromDependency?: true;
}

/** A health path the repository itself declares, rather than one inferred from routes. */
export interface RepoDeclaredHealth {
  path: string;
  /** `HEALTHCHECK`, a compose `healthcheck:`, a k8s/Helm probe, another platform's manifest. */
  kind: 'dockerfile' | 'compose' | 'k8s-probe' | 'platform-manifest';
  source: string;
}

/** A backing service the repository declares it needs. */
export interface RepoDeclaredService {
  /** The engine as declared or as read off the image: `postgres`, `redis`, … */
  kind: string;
  /** The name it carries where it was declared, for a detail an author recognises. */
  name: string;
  source: string;
}

/** A deployable thing in the repository. */
export interface RepoUnit {
  name: string;
  /** Repository-relative root. `''` is the repository itself. */
  root: string;
  dockerfile: string | null;
}

/**
 * Something the repository requires that this platform does not offer: a GPU
 * device request, a mounted docker socket, a privileged container.
 *
 * Deliberately never `fail`. Whether the cluster has a GPU is a cluster fact
 * this family does not hold, and a blocker read off a compose file the manifest
 * may not even build from is not a demonstration — it is a strong hint, which
 * is what `warn` is for.
 */
export interface RepoBlocker {
  code: string;
  summary: string;
  remedy: string;
  source: string;
}

export interface RepoFactsRead {
  read: true;
  boundary: RepoReadBoundary;
  /**
   * Every path in the listing, forward-slashed, repository-relative. The only
   * fact allowed to prove absence, and only when `boundary.listingComplete`.
   *
   * Directories are implied by their files: a build context is present when
   * some path starts with `context + '/'`. An empty directory therefore reads
   * as absent, which is the correct answer for a build context and stated here
   * so nobody discovers it as a surprise.
   */
  files: string[];
  /** Every Dockerfile found anywhere, not only the root one. */
  dockerfiles: string[];
  /** The port the repository evidences — `EXPOSE`, a literal listen, a framework default file. */
  port: RepoEvidence<number> | null;
  declaredHealth: RepoDeclaredHealth[];
  routes: RepoRoute[];
  /**
   * Whether this stack's routes are enumerable at all.
   *
   * The load-bearing field of the whole family. False means the route table is
   * empty because nothing looked, not because nothing is served, and a health
   * path may then only answer `unknown`. Until the reader can state this
   * positively per language, the safe derivation is `routes.length > 0`: a
   * repository that yielded no route has not been searched successfully.
   */
  routesEnumerable: boolean;
  /** Keys the code reads from the environment, each with the line that reads it. */
  envKeysReadByCode: RepoEvidence<string>[];
  declaredServices: RepoDeclaredService[];
  units: RepoUnit[];
  blockers: RepoBlocker[];
}

export interface RepoFactsUnread {
  read: false;
  reason: RepoUnreadReason;
  /** The repository that was going to be read, for a detail that names it. */
  repoFullName: string | null;
  ref: string | null;
}

export type RepoFacts = RepoFactsRead | RepoFactsUnread;

/* ────────────────────────────────────────────────────────────────────────────
 * The functions, as contracts. Implementations land in the next piece.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The repository family. Returns one `repo-snapshot: unknown` and nothing else
 * when `repo.read` is false.
 */
export type RepoChecksFn = (
  claims: ManifestClaims,
  repo: RepoFacts,
) => ManifestCheck[];

/** The ageing family: one check, no repository needed, always answerable. */
export type ManifestCurrencyCheckFn = (
  shape: ManifestShapeFacts,
) => ManifestCheck;

/**
 * What the deploy service calls.
 *
 * `repo` omitted is not the same as `repo.read === false`: omitted means no
 * repository read was attempted, and the output is then byte-identical to
 * today's — the seven installation checks and nothing else. That is the
 * guarantee that no existing surface changes for an installation that never
 * grows a repository read.
 */
export type AllChecksForFn = (
  facts: ManifestFacts,
  self: ManifestSelfFacts,
  repo?: RepoFacts,
) => ManifestCheck[];

/** Kept exported so a consumer can narrow on it without re-deriving the union. */
export type RepoCheckStatus = CheckStatus;

/* ────────────────────────────────────────────────────────────────────────────
 * The implementations.
 *
 * Every function below reads only the facts it is handed — no network, no
 * filesystem, no clock but the one baked into the boundary it was given. The
 * three rules from the header are mechanical here, not just documented:
 *
 *   - a `fail` needs `boundary.listingComplete` (or, for a check with no
 *     listing dependency, is simply never reachable);
 *   - every branch that would otherwise guess turns into `unknown` instead;
 *   - every `detail` names the file (and line, when the evidence carries one)
 *     and says what to do, not just what disagrees.
 * ──────────────────────────────────────────────────────────────────────────── */

const check = (
  id: RepoCheckId,
  status: CheckStatus,
  title: string,
  detail: string,
): ManifestCheck => ({ id, status, title, detail });

const shortSha = (sha: string): string => sha.slice(0, 7);

const plural = (n: number, word: string): string =>
  `${n} ${word}${n === 1 ? '' : 's'}`;

/** `", and N more"`, or `""` when there is nothing left to name. */
const andMore = (rest: number): string =>
  rest > 0 ? `, and ${plural(rest, 'more')}` : '';

/**
 * The one normalisation the build itself already applies, transcribed from
 * `resolveBuildPaths` in `application-source-deploy.service.ts` so the two
 * cannot drift.
 *
 * It is not a nicety. A manifest writes `./Dockerfile` — the form all thirteen
 * official templates use — and `context: .`, the form the CLI's own guide
 * prints; a repository listing carries `Dockerfile` and no entry for the root
 * at all. Compared as raw strings, the correct manifest of every templated
 * application was told its build would fail before it started.
 *
 * `.` is the answer for the repository root, which is what an empty result
 * means here, and it is never a path in a listing.
 */
const normalizePath = (p: string): string => {
  const body = p.startsWith('./') ? p.slice(2) : p;
  let start = 0;
  while (start < body.length && body[start] === '/') start += 1;
  let end = body.length;
  while (end > start && body[end - 1] === '/') end -= 1;
  const v = body.slice(start, end);
  return v === '' ? '.' : v;
};

/** Whether the listing contains this path, both sides normalised. */
const listsPath = (files: string[], target: string): boolean =>
  files.some((f) => normalizePath(f) === target);

/** Whether the listing contains anything under this directory, both sides normalised. */
const listsUnder = (files: string[], prefix: string): boolean =>
  files.some((f) => normalizePath(f).startsWith(prefix));

function unreadDetail(repo: RepoFactsUnread): string {
  const name = repo.repoFullName ?? 'The repository';
  switch (repo.reason) {
    case 'not-connected':
      return `${name} is not connected to this account, so the code could not be read to check the manifest against it.`;
    case 'no-credential':
      return `No GitHub credential in this account can read ${name}, so the code could not be read to check the manifest against it.`;
    case 'not-found': {
      const at = repo.ref ? ` at ${repo.ref}` : '';
      return `${name}${at} could not be found with this credential, so the code could not be read to check the manifest against it.`;
    }
    case 'too-large':
      return `${name} is larger than this check can read in one pass, so the code could not be read to check the manifest against it.`;
    case 'unreadable':
      return `${name} could not be read just now — a network error, a decompression failure, or a timeout — so the code could not be checked against the manifest.`;
    case 'rejected':
      return `${name}'s archive contained an entry outside its own root and was refused whole, so the code could not be read to check the manifest against it.`;
    default:
      return `${name} could not be read, so the code could not be checked against the manifest.`;
  }
}

/**
 * Declares the boundary. The only entry the family emits when `repo.read` is
 * `false`, and the one that turns a truncated read into `unknown` rather than
 * letting the checks below it guess.
 */
function repoSnapshotCheck(repo: RepoFacts): ManifestCheck {
  const title = 'Repository read';
  if (repo.read === false) {
    return check('repo-snapshot', 'unknown', title, unreadDetail(repo));
  }
  const { boundary } = repo;
  if (boundary.listingComplete === true && boundary.contentComplete === true) {
    const symlinkNote =
      boundary.skipped.symlinks > 0
        ? ` ${plural(boundary.skipped.symlinks, 'symlink')} in it were refused and never followed.`
        : '';
    return check(
      'repo-snapshot',
      'pass',
      title,
      `Read commit ${shortSha(boundary.commitSha)} in full: ${plural(boundary.files, 'file')} listed, all read.${symlinkNote}`,
    );
  }
  const gaps: string[] = [];
  if (boundary.listingComplete === false) {
    gaps.push(
      `the file listing stopped early at ${plural(boundary.files, 'path')}, so absence of anything below cannot be proven`,
    );
  }
  if (boundary.contentComplete === false) {
    gaps.push(
      `not every listed file's contents were read (${boundary.bytesRead} bytes retained), so drift in file content may go unnoticed`,
    );
  }
  if (boundary.highDensityUnread.length > 0) {
    gaps.push(
      `${plural(boundary.highDensityUnread.length, 'high-density file')} did not fit under the content ceiling even after being retained first: ${boundary.highDensityUnread.join(', ')}`,
    );
  }
  return check(
    'repo-snapshot',
    'unknown',
    title,
    `Commit ${shortSha(boundary.commitSha)}: ${gaps.join('; and ')}.`,
  );
}

/**
 * `build.dockerfile` against the file the repository actually has.
 *
 * The only branch that can fail on a real listing: the path is named and the
 * complete listing does not contain it. `fail` never fires on a truncated
 * listing — absence proves nothing until the listing is whole. Both sides are
 * normalised first: `./Dockerfile` and `Dockerfile` are the same file, and the
 * build itself has always read them that way.
 */
function repoDockerfileCheck(
  claims: ManifestClaims,
  repo: RepoFactsRead,
): ManifestCheck {
  const title = 'Dockerfile the manifest names';
  const { boundary, files, dockerfiles } = repo;
  const path = claims.dockerfilePath;
  if (path) {
    const wanted = normalizePath(path);
    if (wanted !== '.' && listsPath(files, wanted)) {
      return check(
        'repo-dockerfile',
        'pass',
        title,
        `build.dockerfile (${path}) is in the repository.`,
      );
    }
    if (boundary.listingComplete === false) {
      return check(
        'repo-dockerfile',
        'unknown',
        title,
        `build.dockerfile names ${path}, but the file listing stopped early (${plural(boundary.files, 'path')} seen) and cannot confirm or deny it.`,
      );
    }
    const isDirectory = wanted === '.' || listsUnder(files, `${wanted}/`);
    return check(
      'repo-dockerfile',
      'fail',
      title,
      isDirectory
        ? `build.dockerfile names ${path}, but that is a directory in the repository, not a file. The build will fail before it starts — point it at the Dockerfile inside that directory.`
        : `build.dockerfile names ${path}, and the full listing of commit ${shortSha(boundary.commitSha)} (${plural(files.length, 'file')}) does not contain it. The build will fail before it starts.`,
    );
  }
  if (boundary.listingComplete === false) {
    return check(
      'repo-dockerfile',
      'unknown',
      title,
      'build.dockerfile is not set, and the file listing stopped early, so whether more than one Dockerfile exists cannot be confirmed.',
    );
  }
  if (dockerfiles.length > 1) {
    const others = dockerfiles.filter((d) => d !== 'Dockerfile');
    return check(
      'repo-dockerfile',
      'warn',
      title,
      `build.dockerfile is not set, so the default Dockerfile at the repository root is used — but the repository also has ${others.join(', ')}. Set build.dockerfile if one of those is the one meant to build.`,
    );
  }
  return check(
    'repo-dockerfile',
    'unknown',
    title,
    'build.dockerfile is not set, and the repository has no more than one Dockerfile to be ambiguous about.',
  );
}

/**
 * `build.context` against the tree. An empty directory reads as absent
 * because directories are only ever implied by the files under them — the
 * correct reading for a build context, and one that is stated here on
 * purpose rather than discovered as a surprise.
 *
 * `.`, `./` and `` all name the repository root, which is the same answer as
 * an unset context and never a path in a listing: they take the same `pass`,
 * and not the "nothing under it" `fail` a prefix search would produce.
 */
function repoBuildContextCheck(
  claims: ManifestClaims,
  repo: RepoFactsRead,
): ManifestCheck {
  const title = 'Build context';
  const context = claims.buildContext;
  const { boundary, files } = repo;
  if (!context) {
    return check(
      'repo-build-context',
      'pass',
      title,
      'build.context is not set, so the build uses the repository root, which always exists.',
    );
  }
  const root = normalizePath(context);
  if (root === '.') {
    return check(
      'repo-build-context',
      'pass',
      title,
      `build.context (${context}) is the repository root, which always exists.`,
    );
  }
  const prefix = `${root}/`;
  const contextHasFiles = listsUnder(files, prefix) || listsPath(files, root);
  if (contextHasFiles) {
    const dockerfilePath = claims.dockerfilePath;
    const wantedDockerfile = dockerfilePath
      ? normalizePath(dockerfilePath)
      : null;
    const dockerfileInContext =
      !wantedDockerfile ||
      wantedDockerfile === root ||
      wantedDockerfile.startsWith(prefix);
    if (dockerfilePath && !dockerfileInContext) {
      return check(
        'repo-build-context',
        'warn',
        title,
        `build.context is ${context}, but build.dockerfile (${dockerfilePath}) is outside it. Docker cannot COPY anything from outside the build context, so any COPY of files at the repository root will fail.`,
      );
    }
    return check(
      'repo-build-context',
      'pass',
      title,
      `build.context (${context}) has files under it.`,
    );
  }
  if (boundary.listingComplete === false) {
    return check(
      'repo-build-context',
      'unknown',
      title,
      `build.context is ${context}, but the file listing stopped early and cannot confirm whether it exists.`,
    );
  }
  return check(
    'repo-build-context',
    'fail',
    title,
    `build.context is ${context}, and the full listing of commit ${shortSha(boundary.commitSha)} (${plural(files.length, 'file')}) has nothing under it. The build will fail before it starts.`,
  );
}

/** `deploy.port` against the port the repository evidences. Never `fail` — a container can listen on a port it never declares. */
function repoPortCheck(
  claims: ManifestClaims,
  repo: RepoFactsRead,
): ManifestCheck {
  const title = 'The port the manifest publishes';
  if (claims.port === null) {
    return check(
      'repo-port',
      'unknown',
      title,
      'deploy.port is not set in the manifest, so there is nothing to compare it against.',
    );
  }
  const { port, boundary } = repo;
  if (!port) {
    return check(
      'repo-port',
      'unknown',
      title,
      boundary.contentComplete === true
        ? 'No port evidence (an EXPOSE, a literal listen, or a framework config file) was found in the repository, so deploy.port could not be checked against it.'
        : 'Not every file was read, so no port evidence could be gathered to check deploy.port against.',
    );
  }
  if (claims.port === port.value) {
    return check(
      'repo-port',
      'pass',
      title,
      `deploy.port (${claims.port}) matches ${port.source}.`,
    );
  }
  return check(
    'repo-port',
    'warn',
    title,
    `deploy.port is ${claims.port}, but ${port.source} says ${port.value}. If the container listens on ${port.value}, traffic sent to ${claims.port} will not reach it — set deploy.port to ${port.value}, or change what the app listens on.`,
  );
}

/**
 * `healthcheck.path` against declared health checks and the routes the code
 * serves. The directus rule lives here: a route mounted under a prefix this
 * reader could not locate can neither confirm nor deny the path, so the
 * answer is `unknown`, never `warn` — a false alarm on a health path that was
 * correct all along teaches an author to stop reading this list.
 */
function repoHealthPathCheck(
  claims: ManifestClaims,
  repo: RepoFactsRead,
): ManifestCheck {
  const title = 'The health path the manifest probes';
  const path = claims.healthPath;
  if (!path) {
    return check(
      'repo-health-path',
      'unknown',
      title,
      'healthcheck.path is not set in the manifest, so there is nothing to compare against the repository.',
    );
  }
  const declared = repo.declaredHealth.find((h) => h.path === path);
  if (declared) {
    return check(
      'repo-health-path',
      'pass',
      title,
      `healthcheck.path (${path}) matches the health check declared at ${declared.source}.`,
    );
  }
  const served = repo.routes.find(
    (r) =>
      r.path === path && r.alwaysError !== true && r.prefixUnresolved !== true,
  );
  if (served) {
    return check(
      'repo-health-path',
      'pass',
      title,
      served.fromDependency === true
        ? `healthcheck.path (${path}) is the path the dependency declared at ${served.source} serves by default. No file here registers it, so confirm it answers before the first deploy relies on the probe.`
        : `healthcheck.path (${path}) is a route the code serves, at ${served.source}.`,
    );
  }
  // The path was read, on the line the citation names — and the reader could not
  // say what that line is mounted under. That is neither a confirmation nor a
  // contradiction, and it is the sentence an author can act on, because it hands
  // them the exact file to open. Kept above the boundary and enumerability
  // branches below: those describe what was *not* read, and this route was.
  const fragment = repo.routes.find(
    (r) => r.path === path && r.prefixUnresolved === true,
  );
  if (fragment) {
    return check(
      'repo-health-path',
      'unknown',
      title,
      `${path} is registered at ${fragment.source}, but under a mount point this reader could not locate, so the path the application actually answers is that mount plus ${path} — which may or may not be ${path} itself. Open that file, follow where its router, controller or route group is mounted, and confirm healthcheck.path against the whole path.`,
    );
  }
  if (repo.boundary.contentComplete === false) {
    return check(
      'repo-health-path',
      'unknown',
      title,
      'Not every file was read, so healthcheck.path could not be checked against the routes the code serves.',
    );
  }
  if (repo.routesEnumerable === false) {
    return check(
      'repo-health-path',
      'unknown',
      title,
      `${path} does not match a declared health check, and this stack's routes are not reliably enumerable — "not found here" is not the same as "not served", so this stays unanswered rather than guessed.`,
    );
  }
  const unresolved = repo.routes.filter((r) => r.prefixUnresolved === true);
  if (unresolved.length > 0) {
    return check(
      'repo-health-path',
      'unknown',
      title,
      `${path} was not found among the routes this reader could resolve, but ${plural(unresolved.length, 'route')} (e.g. ${unresolved[0].source}) are mounted under a prefix this reader could not locate — ${path} may be one of them, under a mount point this reader cannot see.`,
    );
  }
  if (repo.routes.length === 0) {
    return check(
      'repo-health-path',
      'unknown',
      title,
      `${path} does not match a declared health check, and no route was found in the code at all — that usually means nothing here searched this stack's routes yet, not that none exist.`,
    );
  }
  return check(
    'repo-health-path',
    'warn',
    title,
    `healthcheck.path is ${path}, and it matches none of the ${plural(repo.routes.length, 'route')} this reader found in the code. If nothing answers there, the health probe fails and the deploy rolls back — confirm the path, or point it at one of the routes this reader found.`,
  );
}

/**
 * A unit root other than the one this manifest covers, when the repository
 * has grown more than one — the same fact `repoUnitsCheck` already reports.
 *
 * Never the repository root (`''`) itself: whether a root-context build's
 * Dockerfile excludes a given subdirectory is not something this family can
 * see (only `build.context`/`build.dockerfile` are read, never a Dockerfile's
 * own `COPY` lines), so only a confirmed, separately-built unit narrows the
 * scope — never the ambiguous "everything else" the root would imply.
 */
function otherUnitRoots(claims: ManifestClaims, repo: RepoFactsRead): string[] {
  if (repo.units.length <= 1) return [];
  const covered = claims.unitPath ?? '';
  return repo.units
    .map((u) => u.root)
    .filter((root) => root !== '' && root !== covered);
}

/** The file half of a `<file>` or `<file>:<line>` source, normalised like every path here. */
function sourceFile(source: string): string {
  return normalizePath(source.replace(/:\d+$/, ''));
}

/** Whether a piece of evidence was read from inside one of the other units. */
function fromOtherUnit(source: string, otherRoots: string[]): boolean {
  if (otherRoots.length === 0) return false;
  const file = sourceFile(source);
  return otherRoots.some(
    (root) => file === root || file.startsWith(`${root}/`),
  );
}

/** Keys the code reads from the environment against what the manifest declares or supplies. Never `fail` — a key can arrive from a base image, an uncommitted `.env`, or a default. */
function repoEnvCheck(
  claims: ManifestClaims,
  repo: RepoFactsRead,
): ManifestCheck {
  const title = 'Environment the code reads';
  const otherRoots = otherUnitRoots(claims, repo);
  const keys = repo.envKeysReadByCode.filter(
    (e) => !fromOtherUnit(e.source, otherRoots),
  );
  if (repo.envKeysReadByCode.length === 0) {
    return check(
      'repo-env',
      'unknown',
      title,
      repo.boundary.contentComplete === true
        ? 'No environment variable reads were found in the code, so there is nothing to compare against deploy.env.'
        : 'Not every file was read, so environment variable reads could not be fully collected.',
    );
  }
  if (keys.length === 0) {
    return check(
      'repo-env',
      'pass',
      title,
      `Every environment read found (${plural(repo.envKeysReadByCode.length, 'key')}) sits in a unit other than the one this manifest covers, so none of it applies to this manifest's deploy.env.`,
    );
  }
  const declared = new Set([
    ...claims.declaredEnvKeys,
    ...claims.suppliedEnvKeys,
  ]);
  const missing = keys.filter((e) => !declared.has(e.value));
  if (missing.length === 0) {
    return check(
      'repo-env',
      'pass',
      title,
      `Every environment variable the code reads is declared or supplied (${plural(keys.length, 'key')} checked).`,
    );
  }
  const shown = missing.slice(0, 5);
  const rest = missing.length - shown.length;
  return check(
    'repo-env',
    'warn',
    title,
    `The code reads ${plural(missing.length, 'variable')} that deploy.env does not declare and nothing supplies: ${shown
      .map((e) => `${e.value} (${e.source})`)
      .join(
        ', ',
      )}${andMore(rest)}. It may still arrive from a base image, an uncommitted .env, or a default in code — add it to deploy.env if it should not be missing.`,
  );
}

/** A compose service the repository declares against what the manifest already provides or links. Never `fail` — the manifest can point at an existing app in a way this comparison does not see. */
function repoServicesCheck(
  claims: ManifestClaims,
  repo: RepoFactsRead,
): ManifestCheck {
  const title = 'Services the repository declares';
  if (repo.boundary.contentComplete === false) {
    return check(
      'repo-services',
      'unknown',
      title,
      repo.declaredServices.length > 0
        ? 'Not every file was read, so a compose file elsewhere in the repository may declare services this check did not see.'
        : 'Not every file was read, so a compose file declaring services could exist that this check has not seen.',
    );
  }
  if (repo.declaredServices.length === 0) {
    return check(
      'repo-services',
      'pass',
      title,
      'The repository does not declare any backing services.',
    );
  }
  const otherRoots = otherUnitRoots(claims, repo);
  const declared = repo.declaredServices.filter(
    (s) => !fromOtherUnit(s.source, otherRoots),
  );
  if (declared.length === 0) {
    return check(
      'repo-services',
      'pass',
      title,
      `Every service the repository declares (${repo.declaredServices.map((s) => s.kind).join(', ')}) sits in a unit other than the one this manifest covers.`,
    );
  }
  const provided = new Set(claims.providedServiceKinds);
  const unmatched = declared.filter((s) => !provided.has(s.kind));
  if (unmatched.length === 0) {
    return check(
      'repo-services',
      'pass',
      title,
      `Every service the repository declares (${declared.map((s) => s.kind).join(', ')}) is provided or linked in deploy.services.`,
    );
  }
  const shown = unmatched.slice(0, 5);
  const rest = unmatched.length - shown.length;
  return check(
    'repo-services',
    'warn',
    title,
    `The repository declares ${plural(unmatched.length, 'service')} the manifest does not provide or link: ${shown
      .map((s) => `${s.name} (${s.kind}, ${s.source})`)
      .join(
        ', ',
      )}${andMore(rest)}. If the app expects to reach it, add it to deploy.services or point at an existing one.`,
  );
}

/** Whether the repository has grown more units than this manifest covers. Never `fail` — a monorepo with one manifest is a legitimate choice. */
function repoUnitsCheck(
  claims: ManifestClaims,
  repo: RepoFactsRead,
): ManifestCheck {
  const title = 'What the repository holds';
  if (repo.boundary.listingComplete === false) {
    return check(
      'repo-units',
      'unknown',
      title,
      'The file listing stopped early, so how many deployable units the repository holds could not be determined.',
    );
  }
  if (repo.units.length === 0) {
    return check(
      'repo-units',
      'unknown',
      title,
      'No deployable unit could be identified in the repository.',
    );
  }
  if (repo.units.length === 1) {
    return check(
      'repo-units',
      'pass',
      title,
      `The repository holds one deployable unit (${repo.units[0].root || '.'}), and this manifest covers it.`,
    );
  }
  const coveredRoot = claims.unitPath ?? '';
  const covered = repo.units.find((u) => u.root === coveredRoot);
  const others = repo.units.filter((u) => u.root !== coveredRoot);
  return check(
    'repo-units',
    'warn',
    title,
    `The repository holds ${plural(repo.units.length, 'deployable unit')}. This manifest covers ${covered ? covered.root || '.' : 'one of them'}; ${others
      .map((u) => u.root || '.')
      .join(
        ', ',
      )} ${others.length === 1 ? 'is' : 'are'} not — each needs its own manifest if it should also deploy.`,
  );
}

/**
 * A requirement the repository asks for that this platform cannot satisfy.
 * Deliberately never `fail` in this piece: whether a GPU exists is a cluster
 * fact this family does not hold, and a blocker read off a compose file the
 * manifest may not even build from is a strong hint, not a demonstration.
 */
function repoBlockersCheck(repo: RepoFactsRead): ManifestCheck {
  const title = 'Requirements nothing here can satisfy';
  if (repo.boundary.contentComplete === false && repo.blockers.length === 0) {
    return check(
      'repo-blockers',
      'unknown',
      title,
      'Not every file was read, so a requirement this platform cannot satisfy might be declared somewhere this check did not see.',
    );
  }
  if (repo.blockers.length === 0) {
    return check(
      'repo-blockers',
      'pass',
      title,
      'Nothing in the repository asks for a GPU, the Docker socket, or privileged execution.',
    );
  }
  const shown = repo.blockers.slice(0, 5);
  const rest = repo.blockers.length - shown.length;
  return check(
    'repo-blockers',
    'warn',
    title,
    `The repository asks for ${plural(repo.blockers.length, 'requirement')} this platform does not offer: ${shown
      .map((b) => `${b.summary} (${b.source}) — ${b.remedy}`)
      .join(
        '; ',
      )}${andMore(rest)}. This may come from a path the manifest does not actually build from — confirm before assuming it applies.`,
  );
}

/**
 * The ageing family, folded into one entry. Answers on every manifest, with
 * or without a repository, because none of it depends on the code — only on
 * what the manifest itself says. Never `unknown`: the manifest is always in
 * hand. Never `fail`: none of this stops anything from working today.
 */
function manifestCurrencyCheck(shape: ManifestShapeFacts): ManifestCheck {
  const title = 'Manifest currency';
  const notes: string[] = [];
  if (shape.apiVersion === 'flui/v1') {
    notes.push(
      'apiVersion is flui/v1, a legacy value still accepted — flui.cloud/v1beta1 is current.',
    );
  }
  if (shape.envForm === 'list') {
    notes.push(
      'deploy.env is written as a list, a form deprecated since spec 0.9.0 — the map form is current.',
    );
  }
  if (shape.inertFields.length > 0) {
    notes.push(
      `${shape.inertFields.join(', ')} ${shape.inertFields.length === 1 ? 'is' : 'are'} present in the manifest but this installation does nothing with ${shape.inertFields.length === 1 ? 'it' : 'them'} yet.`,
    );
  }
  if (shape.resolvedBuildStrategy === 'auto') {
    notes.push(
      'build.strategy is auto, which this installation resolves to Railpack.',
    );
  }
  if (notes.length === 0) {
    return check(
      'manifest-currency',
      'pass',
      title,
      'Nothing in the manifest is aged or inert.',
    );
  }
  return check('manifest-currency', 'warn', title, notes.join(' '));
}

/**
 * The repository family as one call. `repo.read === false` yields exactly
 * `repo-snapshot: unknown` and nothing else — ten `unknown`s in a row teaches
 * a reader to skip the list, which is the same damage as a false alarm.
 */
export const repoChecksFor: RepoChecksFn = (claims, repo) => {
  if (repo.read === false) {
    return [repoSnapshotCheck(repo)];
  }
  return [
    repoSnapshotCheck(repo),
    repoDockerfileCheck(claims, repo),
    repoBuildContextCheck(claims, repo),
    repoPortCheck(claims, repo),
    repoHealthPathCheck(claims, repo),
    repoEnvCheck(claims, repo),
    repoServicesCheck(claims, repo),
    repoUnitsCheck(claims, repo),
    repoBlockersCheck(repo),
  ];
};

export const manifestCurrency: ManifestCurrencyCheckFn = manifestCurrencyCheck;

/**
 * What the deploy service calls. `repo` omitted (not `read: false` — actually
 * omitted) reproduces today's output byte-for-byte: the seven installation
 * checks from `manifest-checks.core.ts`, untouched, and nothing from this
 * file at all except the currency note, which needs no repository to answer.
 */
export const allChecksFor: AllChecksForFn = (facts, self, repo) => {
  const installation = checksFor(facts);
  const repository = repo ? repoChecksFor(self.claims, repo) : [];
  return [...installation, ...repository, manifestCurrencyCheck(self.currency)];
};
