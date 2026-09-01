import { DbCutoverMode, DbMigrationMode } from './enums/db-migration.enum';

/**
 * What a database migration adds to its own sentence.
 *
 * `POST /db-migrations` carries no route parameter: which database moves, where
 * it goes, and — the half that matters most — whether this one call also
 * *finishes* the move all arrive in the body. `cutover` defaults to AUTO and
 * the processor only parks on MANUAL, so the default request is the one where
 * nothing asks a second time before the application is repointed and the source
 * stops taking writes. Pure, fed an unvalidated body and read once — a clause
 * may be nothing else, see `SentenceClause`.
 */
export function dbMigrationClause(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  const source = text(b.srcAppId);
  if (!source) return undefined;
  const cluster = text(b.targetClusterId);
  const what = cluster ? `${source} to cluster ${cluster}` : source;
  return `database ${what}, ${howOf(b)}`;
}

/**
 * An unreadable or absent field reads as the default the service applies, not
 * as an omission: the body is unvalidated here, and both defaults — live
 * replication, automatic cutover — are the ones that go furthest on their own.
 * A sentence that understates the reach is the one failure this must not have.
 */
function howOf(b: Record<string, unknown>): string {
  if (b.mode === DbMigrationMode.RESTORE) {
    return (
      'restored from the backup repository — the live database keeps serving ' +
      'and nothing is repointed at the copy'
    );
  }
  return b.cutover === DbCutoverMode.MANUAL
    ? 'replicated live and parked until somebody fires the cutover'
    : 'replicated live and cut over on its own as soon as it is in sync';
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
