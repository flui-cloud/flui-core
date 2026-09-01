import { FullCutoverMode } from './enums/full-migration.enum';

/**
 * What a full migration adds to its own sentence.
 *
 * `POST /full-migrations` carries no route parameter: which application, which
 * database, where they go, and whether this one call also *finishes* the move
 * all arrive in the body. `cutoverMode` defaults to AUTO and the processor only
 * parks on MANUAL, so the default request is the one that ends with both served
 * from the destination and the source out of traffic, without asking again.
 * Pure, fed an unvalidated body and read once — a clause may be nothing else,
 * see `SentenceClause`.
 */
export function fullMigrationClause(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  const app = text(b.appId);
  if (!app) return undefined;
  const db = text(b.dbAppId);
  const cluster = text(b.targetClusterId);
  const what = db
    ? `application ${app} and database ${db}`
    : `application ${app}`;
  const where = cluster ? ` to cluster ${cluster}` : '';
  // An unreadable or absent `cutover` reads as the default the service applies,
  // which is also the one that goes furthest on its own.
  const how =
    b.cutover === FullCutoverMode.MANUAL
      ? 'parked until somebody fires the joint cutover'
      : 'cut over on their own as soon as both are ready';
  return `${what}${where}, ${how}`;
}

/**
 * Whatever was posted lands verbatim in a sentence a person reads and a
 * concession may keep for good, so it is flattened to one line and cut short
 * rather than trusted.
 */
function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const flat = value.replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}
