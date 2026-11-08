import { BadRequestException, Injectable } from '@nestjs/common';
import { ContinuousBackupEngine } from './continuous-backup-engine.interface';
import { PgBackrestService } from './pgbackrest.service';
import { PgBackrestHaService } from './pgbackrest-ha.service';
import { MariadbPitrService } from './mariadb-pitr.service';
import {
  MariadbDumpService,
  PostgresDumpService,
} from './logical-dump.service';

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

  private readonly fallbacks: ReadonlyMap<string, ContinuousBackupEngine[]>;

  constructor(
    pgbackrest: PgBackrestService,
    mariadb: MariadbPitrService,
    postgresDump: PostgresDumpService,
    mariadbDump: MariadbDumpService,
    pgbackrestHa: PgBackrestHaService,
  ) {
    this.engines = new Map<string, ContinuousBackupEngine>([
      [pgbackrest.engine, pgbackrest],
      [mariadb.engine, mariadb],
      [postgresDump.engine, postgresDump],
      [mariadbDump.engine, mariadbDump],
      [pgbackrestHa.engine, pgbackrestHa],
    ]);
    // A highly available Postgres keeps continuous backup through its own
    // instances before anything falls back to a dump.
    this.fallbacks = new Map<string, ContinuousBackupEngine[]>([
      [pgbackrest.engine, [pgbackrestHa, postgresDump]],
      [mariadb.engine, [mariadbDump]],
    ]);
  }

  /**
   * The engine that will protect this database: continuous when its image
   * can ship its log, a scheduled dump when it cannot — the databases inside
   * catalog bundles run the vendor's image. The continuous engine's refusal is
   * kept when the dump cannot run either, because it names what is missing.
   */
  async chooseFor(
    declaredEngine: string | undefined | null,
    appId: string,
  ): Promise<ContinuousBackupEngine> {
    const continuous = this.forEngine(declaredEngine);
    try {
      await continuous.requireTooling(appId);
      return continuous;
    } catch (err) {
      if (!(err instanceof BadRequestException)) throw err;
      for (const next of this.fallbacks.get(continuous.engine) ?? []) {
        try {
          await next.requireTooling(appId);
          return next;
        } catch {
          continue;
        }
      }
      throw err;
    }
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
