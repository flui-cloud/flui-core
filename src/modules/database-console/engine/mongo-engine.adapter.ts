import { BadRequestException, Injectable } from '@nestjs/common';
import { BSON, MongoClient, MongoClientOptions } from 'mongodb';

/**
 * Serialize driver output to canonical Extended JSON so every BSON type survives
 * the JSON hop to the dashboard with full fidelity: ObjectId → {$oid}, Date →
 * {$date:{$numberLong}}, Int32/Double/Long/Decimal128 each tagged distinctly,
 * Binary/Timestamp/regex too. The json-viewer renders these as MongoDB-tool
 * tokens (ObjectId('…'), ISODate('…'), Long('…'), …) — ints/doubles shown plain.
 * Canonical (not relaxed) is required so a Long > 2^53 keeps full precision
 * instead of degrading to a lossy JS number.
 */
function toEjson<T>(value: T): T {
  return BSON.EJSON.serialize(value, { relaxed: false }) as T;
}

const FIELD_MAX_DEPTH = 8;

function bsonTypeName(v: unknown): string | null {
  if (v instanceof BSON.ObjectId) return 'objectId';
  if (v instanceof Date) return 'date';
  if (v instanceof BSON.Decimal128) return 'decimal';
  // Timestamp extends Long in bson — check it first or it reads as 'long'.
  if (v instanceof BSON.Timestamp) return 'timestamp';
  if (v instanceof BSON.Long) return 'long';
  if (v instanceof BSON.Int32) return 'int';
  if (v instanceof BSON.Double) return 'double';
  if (v instanceof BSON.Binary) return 'binary';
  if (v instanceof BSON.BSONRegExp || v instanceof RegExp) return 'regex';
  return null;
}

function jsTypeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v === 'object' ? 'object' : typeof v;
}

/**
 * Recursively record dotted field paths + the types seen at each. Arrays share
 * the parent path (Mongo's array dotted-path semantics: `rows.field`). BSON
 * scalars are leaves. Used to infer a schemaless collection's shape for autocomplete.
 */
function collectFieldPaths(
  v: unknown,
  prefix: string,
  out: Map<string, Set<string>>,
  depth: number,
): void {
  const bt = bsonTypeName(v);
  if (prefix) {
    let set = out.get(prefix);
    if (!set) {
      set = new Set();
      out.set(prefix, set);
    }
    set.add(bt ?? jsTypeName(v));
  }
  if (bt || depth >= FIELD_MAX_DEPTH) return;
  if (Array.isArray(v)) {
    for (const el of v.slice(0, 5))
      collectFieldPaths(el, prefix, out, depth + 1);
  } else if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      collectFieldPaths(val, prefix ? `${prefix}.${k}` : k, out, depth + 1);
    }
  }
}
import { DbEngine } from '../interfaces/db-connection';
import { aggregateWritesOutput, isReadOnlyCommand } from './mongo-commands';
import {
  CommandResult,
  DocumentCollection,
  DocumentConnectParams,
  DocumentConnection,
  DocumentDatabase,
  DocumentEngineAdapter,
  DocumentField,
  DocumentFieldsOptions,
  DocumentFindOptions,
  DocumentPage,
  DocumentStoreSummary,
} from './document-engine';

class MongoConnection implements DocumentConnection {
  constructor(private readonly client: MongoClient) {}

  // Counts only — never database/collection contents (data-blind store overview).
  async summary(): Promise<DocumentStoreSummary> {
    const { databases } = await this.client.db().admin().listDatabases();
    const out: { name: string; collectionCount: number }[] = [];
    for (const db of databases) {
      const cols = await this.client
        .db(db.name)
        .listCollections({}, { nameOnly: true })
        .toArray();
      out.push({ name: db.name, collectionCount: cols.length });
    }
    return { databaseCount: databases.length, databases: out };
  }

  async databases(): Promise<DocumentDatabase[]> {
    const { databases } = await this.client.db().admin().listDatabases();
    return databases.map((d) => ({
      name: d.name,
      sizeOnDisk: typeof d.sizeOnDisk === 'number' ? d.sizeOnDisk : undefined,
      empty: d.empty,
    }));
  }

  async collections(database: string): Promise<DocumentCollection[]> {
    const db = this.client.db(database);
    const infos = await db.listCollections().toArray();
    const out: DocumentCollection[] = [];
    for (const info of infos) {
      const type = info.type === 'view' ? 'view' : 'collection';
      let estimatedCount: number | undefined;
      if (type === 'collection') {
        // Fast metadata estimate; views/edge cases can throw — leave the count absent.
        estimatedCount = await db
          .collection(info.name)
          .estimatedDocumentCount()
          .catch(() => undefined);
      }
      out.push({ name: info.name, type, estimatedCount });
    }
    return out;
  }

  async find(
    database: string,
    collection: string,
    opts: DocumentFindOptions,
  ): Promise<DocumentPage> {
    const start = Date.now();
    try {
      // Fetch one extra to detect truncation without a second count round-trip.
      const docs = await this.client
        .db(database)
        .collection(collection)
        .find(opts.filter ?? {}, {
          projection: opts.projection,
          sort: opts.sort,
          skip: opts.skip,
          limit: opts.limit + 1,
        })
        .toArray();
      const truncated = docs.length > opts.limit;
      const documents = truncated ? docs.slice(0, opts.limit) : docs;
      return {
        documents: toEjson(documents),
        count: documents.length,
        truncated,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      throw mapMongoError(err);
    }
  }

  async command(
    database: string,
    command: Record<string, unknown>,
    opts: { readOnly: boolean },
  ): Promise<CommandResult> {
    // Decode Extended JSON so typed literals in the command (ObjectId/ISODate/
    // Decimal128/Long/Binary…) reach the driver as real BSON — for inserts and
    // for { _id: ObjectId("…") } matchers. Canonical mode keeps Long/Int/Double
    // distinct. Query operators ($gt, $in, $regex…) are not type wrappers, so
    // they pass through untouched.
    let decoded: Record<string, unknown>;
    try {
      decoded = BSON.EJSON.deserialize(command, {
        relaxed: false,
      }) as Record<string, unknown>;
    } catch (err) {
      // Bad Extended JSON (e.g. a malformed ObjectId hex) is a client error, not a 500.
      throw new BadRequestException(
        `Invalid command (Extended JSON): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const name = String(Object.keys(decoded)[0] ?? '');
    if (!name) throw new BadRequestException('Empty command');
    if (opts.readOnly) {
      const isWrite =
        !isReadOnlyCommand(name) ||
        (name.toLowerCase() === 'aggregate' && aggregateWritesOutput(decoded));
      if (isWrite) {
        throw new BadRequestException({
          statusCode: 400,
          code: 'READ_ONLY',
          message: `${name} is a write command — disable read-only to run it.`,
        });
      }
    }
    const start = Date.now();
    try {
      const reply = await this.client.db(database).command(decoded);
      return { reply: toEjson(reply), durationMs: Date.now() - start };
    } catch (err) {
      throw mapMongoError(err);
    }
  }

  async fields(
    database: string,
    collection: string,
    opts: DocumentFieldsOptions,
  ): Promise<DocumentField[]> {
    const coll = this.client.db(database).collection(collection);
    const docs: unknown[] = [];
    // Random sample across the WHOLE collection — never the first-N (which would
    // be time-clustered and miss fields added as the schema evolved).
    try {
      docs.push(
        ...(await coll
          .aggregate([{ $sample: { size: opts.sampleSize } }])
          .toArray()),
      );
    } catch {
      // $sample unsupported on this store — fall back to the newest docs only.
    }
    // Always union the newest docs by _id so recent schema additions are captured.
    if (opts.recent > 0) {
      docs.push(
        ...(await coll
          .find({}, { sort: { _id: -1 }, limit: opts.recent })
          .toArray()),
      );
    }
    const types = new Map<string, Set<string>>();
    for (const d of docs) collectFieldPaths(d, '', types, 0);
    return [...types.entries()]
      .map(([path, set]) => ({ path, types: [...set] }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => undefined);
  }
}

function mapMongoError(err: unknown): BadRequestException {
  const e = err as { message?: string };
  return new BadRequestException({
    statusCode: 400,
    code: 'MONGO_ERROR',
    message: e.message ?? 'command failed',
  });
}

@Injectable()
export class MongoEngineAdapter implements DocumentEngineAdapter {
  // FerretDB speaks the MongoDB wire protocol — one adapter serves it and any future Mongo store.
  readonly engines: DbEngine[] = ['ferretdb'];

  async connect(params: DocumentConnectParams): Promise<DocumentConnection> {
    const options: MongoClientOptions = {
      // Single pod behind the ephemeral tunnel — skip replica-set topology discovery.
      directConnection: true,
      serverSelectionTimeoutMS: 10_000,
      connectTimeoutMS: 10_000,
    };
    // Empty/absent password → connect anonymously (FerretDB v1 runs auth: none); never send
    // credentials with a blank password.
    if (params.credentials.password) {
      options.auth = {
        username: params.credentials.user || 'admin',
        password: params.credentials.password,
      };
      options.authSource = params.credentials.database || 'admin';
    }
    const client = new MongoClient(
      `mongodb://${params.host}:${params.port}`,
      options,
    );
    try {
      await client.connect();
      // Force the handshake to surface auth/connectivity errors here, not on first query.
      await client.db().admin().ping();
    } catch (err) {
      await client.close().catch(() => undefined);
      throw mapMongoError(err);
    }
    return new MongoConnection(client);
  }
}
