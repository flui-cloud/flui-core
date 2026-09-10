/**
 * The adapter, pure: what cartographer read, in the shape the manifest checks
 * compare against.
 *
 * This is the half that closes the measured hole. Until it existed, the
 * repository family was a module nobody called: a manifest naming a Dockerfile
 * that does not exist, a context that does not exist, and a port and a health
 * path that were invented answered `valid: true` with no warning, because the
 * validation never opened the repository at all.
 *
 * Two rules govern every mapping below, and they are the same two the checks
 * themselves obey:
 *
 * 1. **Nothing is invented.** Every value carries the file (and line, where the
 *    reader had one) it came from; a fact the survey does not hold becomes an
 *    empty list or a `null`, never a plausible default.
 * 2. **The boundary travels with the facts.** A truncated listing and a partial
 *    read arrive as what they are, because they are what forbids the checks
 *    from concluding absence.
 *
 * It lives beside the checks rather than in the service so it can be tested
 * without the network stack: nothing here imports Nest or an HTTP client, and
 * the tree it reads is an ordinary object.
 */

import { buildRepoSurvey } from '@flui-cloud/cartographer';
import type { RepoSurvey } from '@flui-cloud/cartographer';
import type { RepoTreeRead } from './services/repo-tree-reader.service';
import type {
  RepoBlocker,
  RepoDeclaredHealth,
  RepoDeclaredService,
  RepoFactsRead,
  RepoRoute,
  RepoUnit,
} from './manifest-repo-checks.core';

/** `Dockerfile`, `Dockerfile.prod`, `docker/Dockerfile`, `api.dockerfile`. */
const DOCKERFILE = /(^|\/)(Dockerfile(\.[^/]+)?|[^/]+\.dockerfile)$/i;

/**
 * A read tree in, the facts the checks compare against out. No network, no
 * filesystem, no clock.
 */
export function repoFactsFrom(tree: RepoTreeRead): RepoFactsRead {
  const survey = buildRepoSurvey(tree.scan);
  const { detection } = survey;
  const files = tree.scan.files;

  return {
    read: true,
    boundary: {
      commitSha: tree.commitSha,
      ref: tree.ref,
      files: files.length,
      listingComplete: tree.truncated === false,
      bytesRead: tree.bytesRead,
      contentComplete: tree.contentComplete,
      skipped: tree.skipped,
      notFound: detection.notFound,
      highDensityUnread: tree.highDensityUnread,
    },
    files,
    dockerfiles: files.filter((f) => DOCKERFILE.test(f)),
    port: detection.port
      ? { value: detection.port.value, source: detection.port.source }
      : null,
    declaredHealth: declaredHealthFrom(survey),
    routes: routesFrom(survey),
    // The safe derivation the family's own doc prescribes: a repository that
    // yielded no route has not been searched successfully, and an empty table
    // may then never contradict a manifest.
    routesEnumerable: detection.routes.length > 0,
    envKeysReadByCode: detection.env.keys
      // `codeOnly` is the classification that carries a *code* line. A key an
      // example file names is evidence about the example file, and this field
      // is contracted as "keys the code reads, with the line that reads it".
      .filter((k) => k.classification === 'codeOnly')
      .map((k) => ({ value: k.name, source: k.source })),
    declaredServices: declaredServicesFrom(survey),
    units: unitsFrom(survey),
    blockers: blockersFrom(survey),
  };
}

/**
 * A declared health check is only usable here when it yields a path: a
 * `pg_isready` exec probe declares a health check and no HTTP path, and
 * offering it as one would be inventing the very thing this family refuses to
 * invent.
 */
function declaredHealthFrom(survey: RepoSurvey): RepoDeclaredHealth[] {
  const found: RepoDeclaredHealth[] = [];
  for (const c of survey.health.checks) {
    const path = c.httpGet?.path ?? c.command?.path ?? null;
    if (path) found.push({ path, kind: c.kind, source: c.source });
  }
  return found;
}

function routesFrom(survey: RepoSurvey): RepoRoute[] {
  return survey.detection.routes.map((r) => ({
    path: r.path,
    source: r.source,
    ...(r.prefixUnresolved ? { prefixUnresolved: true as const } : {}),
    ...(r.alwaysError ? { alwaysError: true as const } : {}),
    ...(r.fromDependency ? { fromDependency: true as const } : {}),
  }));
}

/**
 * The engine is what a manifest can be compared against — `postgres`, `redis`.
 * The catalog ref is the fallback where the survey resolved no engine, and the
 * author's own handle the last one: a name is still something a reader
 * recognises, and dropping the service entirely would hide it.
 */
function declaredServicesFrom(survey: RepoSurvey): RepoDeclaredService[] {
  return survey.resolution.services.map((s) => ({
    kind: (s.engine ?? s.block ?? s.name).toLowerCase(),
    name: s.name,
    source: s.source,
  }));
}

/** `''` is this family's name for the repository root; cartographer's is `.`. */
function unitsFrom(survey: RepoSurvey): RepoUnit[] {
  return survey.units.units.map((u) => ({
    name: u.name,
    root: u.root === '.' ? '' : u.root,
    dockerfile: u.dockerfile?.value ?? null,
  }));
}

function blockersFrom(survey: RepoSurvey): RepoBlocker[] {
  return survey.blockers.map((b) => ({
    code: b.code,
    summary: b.summary,
    remedy: b.remedy,
    source: b.source,
  }));
}
