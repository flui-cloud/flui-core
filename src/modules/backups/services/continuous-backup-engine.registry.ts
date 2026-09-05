import { BadRequestException, Injectable } from '@nestjs/common';
import { ContinuousBackupEngine } from './continuous-backup-engine.interface';
import { PgBackrestService } from './pgbackrest.service';
import { MariadbPitrService } from './mariadb-pitr.service';

/**
 * Finds the engine that owns a policy or an artifact.
 *
 * Looked up by the value persisted on the row, never re-derived from the
 * application: a disaster restore runs when that application is gone, so the
 * row has to be self-sufficient. An unknown engine is refused loudly rather
 * than falling back to Postgres — a silent fallback would restore one database
 * with another's tool.
 */
@Injectable()
export class ContinuousBackupEngineRegistry {
  private readonly engines: ReadonlyMap<string, ContinuousBackupEngine>;

  constructor(pgbackrest: PgBackrestService, mariadb: MariadbPitrService) {
    this.engines = new Map<string, ContinuousBackupEngine>([
      [pgbackrest.engine, pgbackrest],
      [mariadb.engine, mariadb],
    ]);
  }

  /**
   * Rows written before the engine column existed carry no value, and every
   * one of them came from pgBackRest — `database` had a single implementation
   * until MariaDB. Reading them as Postgres is a fact about the past, not a
   * default for the future.
   */
  forEngine(engine: string | undefined | null): ContinuousBackupEngine {
    const found = this.engines.get(engine ?? 'postgres');
    if (!found) {
      throw new BadRequestException(
        `No continuous-backup engine is registered for "${engine}". This ` +
          'backup was taken by a version of Flui that supported it; restoring ' +
          'it needs that engine back.',
      );
    }
    return found;
  }

  /** Every registered engine — for callers that must sweep all their traces. */
  all(): ContinuousBackupEngine[] {
    return [...this.engines.values()];
  }

  supports(engine: string | undefined | null): boolean {
    return this.engines.has(engine ?? 'postgres');
  }
}
