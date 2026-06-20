import { Segment, bad, parseArgs, parseDbChain } from './mongo-shell-parse';
import { collectionMethod, databaseLevel, plan } from './mongo-shell-commands';
import type { ShellPlan } from './mongo-shell-commands';

export type { ShellPlan, ShellResultShape } from './mongo-shell-commands';

/**
 * mongosh-syntax → Mongo command translator for the document console shell.
 *
 * The shell gives mongosh users their own tool's UX (db.coll.find({…}), show
 * collections, …) WITHOUT evaluating arbitrary JavaScript anywhere: a statement
 * is parsed into a single Mongo command document, which then runs through the
 * SAME read-only-gated `command` path as everything else (audit + EJSON kept).
 * No eval on the control-plane, no eval in the browser — see the security model.
 *
 * It is faithful for the everyday command surface (CRUD + cursor modifiers +
 * aggregate + the common db/collection helpers). Anything outside it raises a
 * clear error pointing at db.runCommand({…}). A future upgrade to 100% fidelity
 * is @mongosh/browser-runtime-core proxied to the backend (Compass-web model).
 */

// db.<name>(…) calls handled at the database level (not collection accessors).
const DB_LEVEL_METHODS = new Set([
  'runCommand',
  'command',
  'adminCommand',
  'stats',
  'getCollectionNames',
  'getCollectionInfos',
  'createCollection',
  'dropDatabase',
  'serverStatus',
  'hostInfo',
  'version',
]);

function resolveCollection(
  first: Segment,
  segs: Segment[],
): { collection: string; rest: Segment[] } {
  if (first.call && first.name === 'getCollection') {
    const a = parseArgs(first.args);
    if (typeof a[0] !== 'string') {
      throw bad('getCollection() needs a collection name string');
    }
    return { collection: a[0], rest: segs.slice(1) };
  }
  if (first.call) {
    throw bad(
      `Unsupported db method "${first.name}()". Use db.runCommand({ … }) for raw commands.`,
    );
  }
  return { collection: first.name, rest: segs.slice(1) };
}

/**
 * Translate one mongosh statement into a runnable Mongo command plan. Handles
 * `show dbs|collections` helpers, db-level methods, and db.<collection>.<method>(…)
 * chains. `currentDb` is the shell's active database (for everything but listDatabases).
 */
export function translateShellStatement(
  input: string,
  currentDb: string,
): ShellPlan {
  const stmt = input.trim().replace(/;+\s*$/, '');
  if (!stmt) throw bad('Empty statement');

  const lower = stmt.toLowerCase();
  if (lower === 'show dbs' || lower === 'show databases') {
    return plan('admin', { listDatabases: 1 }, 'databases', false);
  }
  if (lower === 'show collections' || lower === 'show tables') {
    return plan(
      currentDb,
      { listCollections: 1, nameOnly: true },
      'collectionNames',
      false,
    );
  }

  if (!/^db\b/.test(stmt)) {
    throw bad(
      'Statements must start with "db" (e.g. db.users.find({})) or be "show dbs" / "show collections".',
    );
  }

  const segs = parseDbChain(stmt);
  if (segs.length === 0) {
    throw bad('Incomplete statement. Try db.<collection>.find({}).');
  }

  const first = segs[0];
  if (first.call && DB_LEVEL_METHODS.has(first.name)) {
    return databaseLevel(currentDb, first);
  }

  const { collection, rest } = resolveCollection(first, segs);
  const methodSeg = rest[0];
  if (!methodSeg?.call) {
    throw bad(`Expected a method call, e.g. db.${collection}.find({}).`);
  }
  return collectionMethod(currentDb, collection, methodSeg, rest.slice(1));
}
