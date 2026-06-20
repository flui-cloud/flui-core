/**
 * Read-only command classification for the document console. The console runs in read-only
 * mode by default: a command whose name is NOT in this set is treated as a write and rejected
 * unless the operator turns read-only off (mirrors the SQL transaction gate and the key-value
 * command gate). Unknown commands default to write — fail safe.
 *
 * The command NAME is the first key of a Mongo command document, e.g. `{ find: "users", ... }`.
 * Matching is case-insensitive (Mongo accepts both `isMaster` and `ismaster`).
 */
const READ_ONLY_COMMANDS = new Set<string>([
  // server / cluster introspection
  'ping',
  'hello',
  'ismaster',
  'buildinfo',
  'serverstatus',
  'connectionstatus',
  'getparameter',
  'hostinfo',
  'getlog',
  'whatsmyuri',
  'listcommands',
  'currentop',
  // database / collection introspection
  'listdatabases',
  'listcollections',
  'listindexes',
  'dbstats',
  'collstats',
  'dbhash',
  'validate',
  // reads
  'find',
  'getmore',
  'aggregate', // gated further: $out/$merge stages are writes (checked by the caller)
  'count',
  'distinct',
  'explain',
]);

/** True when `name` is a known read-only Mongo command (case-insensitive). */
export function isReadOnlyCommand(name: string): boolean {
  return READ_ONLY_COMMANDS.has(name.toLowerCase());
}

/**
 * An aggregate pipeline that ends in `$out` or `$merge` writes a collection, so it must NOT
 * pass the read-only gate even though `aggregate` is otherwise a read command.
 */
export function aggregateWritesOutput(
  command: Record<string, unknown>,
): boolean {
  const pipeline = command.pipeline;
  if (!Array.isArray(pipeline)) return false;
  return pipeline.some(
    (stage) =>
      stage != null &&
      typeof stage === 'object' &&
      ('$out' in stage || '$merge' in stage),
  );
}
