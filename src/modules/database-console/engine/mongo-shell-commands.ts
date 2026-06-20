import { aggregateWritesOutput } from './mongo-commands';
import {
  Segment,
  asArray,
  asObject,
  bad,
  parseArgs,
} from './mongo-shell-parse';

/** How the dashboard should render the reply (mongosh-like presentation). */
export type ShellResultShape =
  | 'cursor' // reply.cursor.firstBatch → document list
  | 'firstDoc' // reply.cursor.firstBatch[0] → single document or null
  | 'count' // reply.n → number
  | 'distinct' // reply.values → array
  | 'databases' // reply.databases → database list
  | 'collectionNames' // reply.cursor.firstBatch → name list
  | 'insert' // reply.n → inserted count
  | 'update' // reply.{n,nModified,upserted}
  | 'delete' // reply.n → deleted count
  | 'raw'; // the whole reply, as-is

export interface ShellPlan {
  /** Database the command runs against ('admin' for listDatabases). */
  database: string;
  /** Mongo command with REAL BSON values; serialize to EJSON before running. */
  command: Record<string, unknown>;
  /** The Mongo command name (first key) — drives the read-only gate + audit. */
  method: string;
  /** How the reply should be rendered. */
  shape: ShellResultShape;
  /** True when the statement writes/destroys data (UI awareness; gate is authoritative). */
  mutation: boolean;
}

// Default page when a find() carries no .limit() — mirrors a shell batch. The user
// can widen it with .limit(n). Keeps a stray db.coll.find() from streaming everything.
const SHELL_DEFAULT_LIMIT = 20;

export function plan(
  database: string,
  command: Record<string, unknown>,
  shape: ShellResultShape,
  mutation: boolean,
): ShellPlan {
  return {
    database,
    command,
    method: String(Object.keys(command)[0] ?? ''),
    shape,
    mutation,
  };
}

// Apply trailing cursor modifiers (.sort/.limit/.skip/.projection/.hint) onto a find.
// Presentation-only modifiers (.pretty/.toArray/…) are ignored; unknown ones are too.
function applyCursorMods(
  command: Record<string, unknown>,
  mods: Segment[],
): void {
  for (const m of mods) {
    if (!m.call) continue;
    const a = parseArgs(m.args);
    switch (m.name) {
      case 'sort':
        command.sort = asObject(a[0], 'sort()');
        break;
      case 'limit':
        command.limit = Number(a[0]);
        break;
      case 'skip':
        command.skip = Number(a[0]);
        break;
      case 'project':
      case 'projection':
        command.projection = asObject(a[0], 'projection()');
        break;
      case 'hint':
        command.hint = a[0];
        break;
      default:
        break; // .pretty(), .toArray(), .readPref(), … — no effect on the command
    }
  }
}

function updateSpec(args: unknown[], multi: boolean): Record<string, unknown> {
  const q = asObject(args[0], 'update filter');
  const u = args[1];
  if (u === undefined || (typeof u !== 'object' && !Array.isArray(u))) {
    throw bad(
      'update needs a modifier document or pipeline, e.g. { $set: { … } }',
    );
  }
  const opts = (args[2] as Record<string, unknown>) ?? {};
  return { q, u, multi, upsert: opts.upsert === true };
}

function createIndexCommand(
  coll: string,
  args: unknown[],
): Record<string, unknown> {
  const key = asObject(args[0], 'createIndex()');
  const opts = (args[1] as Record<string, unknown>) ?? {};
  const name =
    typeof opts.name === 'string'
      ? opts.name
      : Object.entries(key)
          .map(([k, v]) => `${k}_${String(v)}`)
          .join('_');
  return { createIndexes: coll, indexes: [{ ...opts, key, name }] };
}

type CollectionBuilder = (
  database: string,
  coll: string,
  args: unknown[],
  mods: Segment[],
) => ShellPlan;

const COLLECTION_BUILDERS: Record<string, CollectionBuilder> = {
  find: (db, coll, args, mods) => {
    const command: Record<string, unknown> = {
      find: coll,
      filter: args[0] ? asObject(args[0], 'find()') : {},
    };
    if (args[1]) command.projection = asObject(args[1], 'find() projection');
    applyCursorMods(command, mods);
    if (command.limit === undefined) command.limit = SHELL_DEFAULT_LIMIT;
    return plan(db, command, 'cursor', false);
  },
  findOne: (db, coll, args) => {
    const command: Record<string, unknown> = {
      find: coll,
      filter: args[0] ? asObject(args[0], 'findOne()') : {},
      limit: 1,
    };
    if (args[1]) command.projection = asObject(args[1], 'findOne() projection');
    return plan(db, command, 'firstDoc', false);
  },
  aggregate: (db, coll, args) => {
    const command: Record<string, unknown> = {
      aggregate: coll,
      pipeline: args[0] ? asArray(args[0], 'aggregate()') : [],
      cursor: {},
    };
    return plan(db, command, 'cursor', aggregateWritesOutput(command));
  },
  count: (db, coll, args) =>
    plan(
      db,
      { count: coll, query: args[0] ? asObject(args[0], 'count()') : {} },
      'count',
      false,
    ),
  countDocuments: (db, coll, args) =>
    plan(
      db,
      { count: coll, query: args[0] ? asObject(args[0], 'count()') : {} },
      'count',
      false,
    ),
  estimatedDocumentCount: (db, coll) =>
    plan(db, { count: coll }, 'count', false),
  distinct: (db, coll, args) => {
    if (typeof args[0] !== 'string') {
      throw bad(
        'distinct() needs a field name string, e.g. distinct("status")',
      );
    }
    const command: Record<string, unknown> = { distinct: coll, key: args[0] };
    if (args[1]) command.query = asObject(args[1], 'distinct() query');
    return plan(db, command, 'distinct', false);
  },
  getIndexes: (db, coll) => plan(db, { listIndexes: coll }, 'cursor', false),
  getIndexKeys: (db, coll) => plan(db, { listIndexes: coll }, 'cursor', false),
  insertOne: (db, coll, args) =>
    plan(
      db,
      { insert: coll, documents: [asObject(args[0], 'insertOne()')] },
      'insert',
      true,
    ),
  insertMany: (db, coll, args) =>
    plan(
      db,
      { insert: coll, documents: asArray(args[0], 'insertMany()') },
      'insert',
      true,
    ),
  updateOne: (db, coll, args) =>
    plan(
      db,
      { update: coll, updates: [updateSpec(args, false)] },
      'update',
      true,
    ),
  updateMany: (db, coll, args) =>
    plan(
      db,
      { update: coll, updates: [updateSpec(args, true)] },
      'update',
      true,
    ),
  replaceOne: (db, coll, args) => {
    const replacement = asObject(args[1], 'replaceOne()');
    const opts = (args[2] as Record<string, unknown>) ?? {};
    return plan(
      db,
      {
        update: coll,
        updates: [
          {
            q: asObject(args[0], 'replaceOne() filter'),
            u: replacement,
            multi: false,
            upsert: opts.upsert === true,
          },
        ],
      },
      'update',
      true,
    );
  },
  deleteOne: (db, coll, args) =>
    plan(
      db,
      {
        delete: coll,
        deletes: [
          { q: args[0] ? asObject(args[0], 'deleteOne()') : {}, limit: 1 },
        ],
      },
      'delete',
      true,
    ),
  deleteMany: (db, coll, args) =>
    plan(
      db,
      {
        delete: coll,
        deletes: [
          { q: args[0] ? asObject(args[0], 'deleteMany()') : {}, limit: 0 },
        ],
      },
      'delete',
      true,
    ),
  createIndex: (db, coll, args) =>
    plan(db, createIndexCommand(coll, args), 'raw', true),
  dropIndex: (db, coll, args) =>
    plan(db, { dropIndexes: coll, index: args[0] }, 'raw', true),
  drop: (db, coll) => plan(db, { drop: coll }, 'raw', true),
};

export function collectionMethod(
  database: string,
  coll: string,
  methodSeg: Segment,
  mods: Segment[],
): ShellPlan {
  const args = parseArgs(methodSeg.args);
  const builder = COLLECTION_BUILDERS[methodSeg.name];
  if (!builder) {
    throw bad(
      `Unsupported method ".${methodSeg.name}()". Supported: find, findOne, aggregate, ` +
        `count(Documents), estimatedDocumentCount, distinct, getIndexes, insertOne, insertMany, ` +
        `updateOne, updateMany, replaceOne, deleteOne, deleteMany, createIndex, dropIndex, drop. ` +
        `Use db.runCommand({ … }) for anything else.`,
    );
  }
  return builder(database, coll, args, mods);
}

const DB_READ_COMMANDS = new Set([
  'find',
  'aggregate',
  'count',
  'distinct',
  'listcollections',
  'listindexes',
  'listdatabases',
  'dbstats',
  'collstats',
  'ping',
  'hello',
  'buildinfo',
  'serverstatus',
]);

export function databaseLevel(database: string, seg: Segment): ShellPlan {
  const args = parseArgs(seg.args);
  switch (seg.name) {
    case 'runCommand':
    case 'command': {
      const command = asObject(args[0], `${seg.name}()`);
      const name = String(Object.keys(command)[0] ?? '').toLowerCase();
      // The gate re-checks; this only drives UI awareness.
      return plan(database, command, 'raw', !DB_READ_COMMANDS.has(name));
    }
    case 'adminCommand':
      return plan('admin', asObject(args[0], 'adminCommand()'), 'raw', false);
    case 'stats':
      return plan(database, { dbStats: 1 }, 'raw', false);
    case 'getCollectionNames':
      return plan(
        database,
        { listCollections: 1, nameOnly: true },
        'collectionNames',
        false,
      );
    case 'getCollectionInfos':
      return plan(database, { listCollections: 1 }, 'cursor', false);
    case 'createCollection':
      if (typeof args[0] !== 'string') {
        throw bad('createCollection() needs a name string');
      }
      return plan(database, { create: args[0] }, 'raw', true);
    case 'dropDatabase':
      return plan(database, { dropDatabase: 1 }, 'raw', true);
    case 'serverStatus':
      return plan(database, { serverStatus: 1 }, 'raw', false);
    case 'hostInfo':
      return plan(database, { hostInfo: 1 }, 'raw', false);
    case 'version':
      return plan(database, { buildInfo: 1 }, 'raw', false);
    default:
      throw bad(`Unsupported db method "${seg.name}()".`);
  }
}
