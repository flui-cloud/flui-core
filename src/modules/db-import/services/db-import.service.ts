import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bull';
import { In, Repository } from 'typeorm';
import { ApplicationsRepository } from '../../applications/repositories/applications.repository';
import { ApplicationAccessService } from '../../applications/services/application-access.service';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { DbPodExecService } from '../../db-lifecycle/services/db-pod-exec.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import {
  externalPgSourceProblems,
  ExternalPgSource,
  importObjectNames,
} from '../../db-lifecycle/utils/external-pg.core';
import {
  ACTIVE_IMPORT_STATUSES,
  DbImportEngine,
  DbImportEntity,
  DbImportStatus,
} from '../entities/db-import.entity';
import { DB_IMPORT_JOBS, DB_IMPORT_QUEUE } from '../db-import.constants';
import { ImportContext, ImportRunner } from './import-runner';
import { PgImportRunner } from './pg-import.runner';
import { MariadbImportRunner } from './mariadb-import.runner';

export interface StartDbImportInput {
  source: ExternalPgSource;
  password: string;
}

export interface DbImportView {
  id: string;
  applicationId: string;
  engine: DbImportEngine;
  status: DbImportStatus;
  source: ExternalPgSource;
  tablesTotal: number | null;
  tablesCopied: number | null;
  lagBytes: number | null;
  lagSeconds: number | null;
  tablesWithoutKey: string[];
  detail: string | null;
  createdAt: Date;
  endedAt: Date | null;
}

/** The engine of a database installed from the catalog, read from what its image needs. */
export function engineOf(
  app: Pick<ApplicationEntity, 'env'>,
): DbImportEngine | null {
  const has = (name: string) => app.env?.some((e) => e.name === name);
  if (has('POSTGRES_USER')) return 'postgres';
  if (has('MARIADB_ROOT_PASSWORD')) return 'mariadb';
  return null;
}

@Injectable()
export class DbImportService {
  private readonly logger = new Logger(DbImportService.name);

  constructor(
    @InjectRepository(DbImportEntity)
    private readonly imports: Repository<DbImportEntity>,
    private readonly applications: ApplicationsRepository,
    private readonly access: ApplicationAccessService,
    private readonly exec: DbPodExecService,
    private readonly encryption: EncryptionService,
    @InjectQueue(DB_IMPORT_QUEUE) private readonly queue: Queue,
    private readonly pg: PgImportRunner,
    private readonly mariadb: MariadbImportRunner,
  ) {}

  async start(
    user: AuthenticatedUser,
    applicationId: string,
    input: StartDbImportInput,
  ): Promise<DbImportView> {
    const app = await this.application(applicationId);
    await this.access.assertCan(user, 'app:write', app);
    const engine = engineOf(app);
    if (!engine) {
      throw new BadRequestException(
        'An import goes into a PostgreSQL or MariaDB installed from the Flui catalog; this application is neither.',
      );
    }
    const problems = externalPgSourceProblems(input.source);
    if (!input.password || /[\r\n]/.test(input.password)) {
      problems.push('password is required and cannot contain a line break');
    }
    if (problems.length) throw new BadRequestException(problems.join('; '));
    const running = await this.imports.findOne({
      where: {
        targetApplicationId: applicationId,
        status: In(ACTIVE_IMPORT_STATUSES),
      },
    });
    if (running) {
      throw new ConflictException(
        'An import into this database is already running. Finish or cancel it first.',
      );
    }
    const row = await this.imports.save(
      this.imports.create({
        targetApplicationId: applicationId,
        userId: user.userId ?? null,
        engine,
        source: input.source,
        sourcePasswordEncrypted: this.encryption.encrypt(input.password),
        status: DbImportStatus.CHECKING,
        objectName: 'pending',
      }),
    );
    row.objectName = importObjectNames(row.id).publication;
    await this.imports.save(row);
    await this.queue.add(DB_IMPORT_JOBS.COPY, { importId: row.id });
    return this.toView(row);
  }

  async view(
    user: AuthenticatedUser,
    applicationId: string,
  ): Promise<DbImportView | null> {
    const app = await this.application(applicationId);
    await this.access.assertCan(user, 'app:read', app);
    const row = await this.latest(applicationId);
    if (!row) return null;
    let lagSeconds: number | null = null;
    if (
      row.status === DbImportStatus.COPYING ||
      row.status === DbImportStatus.STREAMING
    ) {
      try {
        const ctx = await this.context(row, app);
        const progress = await this.runner(row).progress(ctx);
        if (progress.streaming) row.status = DbImportStatus.STREAMING;
        lagSeconds = progress.lagSeconds;
        await this.imports.save(row);
      } catch (err) {
        this.logger.warn(
          `[db-import] ${row.id} not refreshed: ${(err as Error).message}`,
        );
      }
    }
    return this.toView(row, lagSeconds);
  }

  async cutover(
    user: AuthenticatedUser,
    applicationId: string,
  ): Promise<DbImportView> {
    const app = await this.application(applicationId);
    await this.access.assertCan(user, 'app:write', app);
    const row = await this.latest(applicationId);
    if (row?.status !== DbImportStatus.STREAMING) {
      throw new ConflictException(
        'The switch is possible once every table is copied and changes are streaming.',
      );
    }
    row.status = DbImportStatus.CUTTING_OVER;
    row.detail = null;
    await this.imports.save(row);
    await this.queue.add(DB_IMPORT_JOBS.CUTOVER, { importId: row.id });
    return this.toView(row);
  }

  async abort(
    user: AuthenticatedUser,
    applicationId: string,
  ): Promise<DbImportView> {
    const app = await this.application(applicationId);
    await this.access.assertCan(user, 'app:write', app);
    const row = await this.latest(applicationId);
    if (!row || !ACTIVE_IMPORT_STATUSES.includes(row.status)) {
      throw new NotFoundException('No import is running into this database.');
    }
    await this.queue.add(DB_IMPORT_JOBS.ABORT, { importId: row.id });
    return this.toView(row);
  }

  async runCopy(importId: string): Promise<void> {
    const row = await this.imports.findOneByOrFail({ id: importId });
    if (row.status !== DbImportStatus.CHECKING) return;
    const ctx = await this.context(row);
    try {
      const refused = await this.runner(row).copy(ctx);
      if (refused) {
        await this.end(row, DbImportStatus.FAILED, refused);
        return;
      }
      row.status = DbImportStatus.COPYING;
      await this.imports.save(row);
      this.logger.log(
        `[db-import] ${row.id}: copying ${row.tablesTotal ?? '?'} table(s) into ${ctx.target.slug}`,
      );
    } catch (err) {
      const notes = await this.runner(row).cleanUp(ctx);
      await this.end(
        row,
        DbImportStatus.FAILED,
        [describeSourceError(err), ...notes].join(' '),
      );
    }
  }

  async runCutover(importId: string): Promise<void> {
    const row = await this.imports.findOneByOrFail({ id: importId });
    if (row.status !== DbImportStatus.CUTTING_OVER) return;
    const ctx = await this.context(row);
    try {
      if (!(await this.runner(row).caughtUp(ctx))) {
        row.status = DbImportStatus.STREAMING;
        row.detail =
          'Changes kept arriving from the source. Stop every write to it, then switch again.';
        await this.imports.save(row);
        return;
      }
      const notes = await this.runner(row).finish(ctx);
      await this.end(
        row,
        DbImportStatus.COMPLETED,
        notes.length ? notes.join(' ') : null,
      );
    } catch (err) {
      row.status = DbImportStatus.STREAMING;
      row.detail = `The switch did not finish: ${describeSourceError(err)} Nothing was removed; try again.`;
      await this.imports.save(row);
    }
  }

  async runAbort(importId: string): Promise<void> {
    const row = await this.imports.findOneByOrFail({ id: importId });
    if (!ACTIVE_IMPORT_STATUSES.includes(row.status)) return;
    const notes = await this.runner(row).cleanUp(await this.context(row));
    await this.end(
      row,
      DbImportStatus.ABORTED,
      [
        'Cancelled. What was already copied stays in the Flui database.',
        ...notes,
      ].join(' '),
    );
  }

  private runner(row: DbImportEntity): ImportRunner {
    return row.engine === 'mariadb' ? this.mariadb : this.pg;
  }

  private async context(
    row: DbImportEntity,
    app?: ApplicationEntity,
  ): Promise<ImportContext> {
    const target = await this.exec.resolve(row.targetApplicationId);
    const owner = app ?? (await this.application(row.targetApplicationId));
    return {
      row,
      target,
      targetDatabase:
        row.engine === 'mariadb'
          ? (this.exec.envValue(owner, 'MARIADB_DATABASE') ?? 'mysql')
          : target.pgDb,
      password: this.password(row),
    };
  }

  private async end(
    row: DbImportEntity,
    status: DbImportStatus,
    detail: string | null,
  ): Promise<void> {
    row.status = status;
    row.detail = detail;
    row.sourcePasswordEncrypted = null;
    row.endedAt = new Date();
    await this.imports.save(row);
    const why = detail ? ` — ${detail}` : '';
    this.logger.log(`[db-import] ${row.id}: ${status}${why}`);
  }

  private password(row: DbImportEntity): string {
    if (!row.sourcePasswordEncrypted) {
      throw new Error('The source password is no longer held for this import');
    }
    return this.encryption.decrypt(row.sourcePasswordEncrypted);
  }

  private async application(id: string): Promise<ApplicationEntity> {
    const app = await this.applications.findById(id);
    if (!app) throw new NotFoundException('Application not found');
    return app;
  }

  private latest(applicationId: string): Promise<DbImportEntity | null> {
    return this.imports.findOne({
      where: { targetApplicationId: applicationId },
      order: { createdAt: 'DESC' },
    });
  }

  private toView(
    row: DbImportEntity,
    lagSeconds: number | null = null,
  ): DbImportView {
    return {
      id: row.id,
      applicationId: row.targetApplicationId,
      engine: row.engine,
      status: row.status,
      source: row.source,
      tablesTotal: row.tablesTotal,
      tablesCopied: row.tablesCopied,
      lagBytes: row.lagBytes === null ? null : Number(row.lagBytes),
      lagSeconds,
      tablesWithoutKey: row.tablesWithoutKey ?? [],
      detail: row.detail,
      createdAt: row.createdAt,
      endedAt: row.endedAt,
    };
  }
}

/** A connection failure says where to look; anything else is passed on as the source said it. */
export function describeSourceError(err: unknown): string {
  const raw = err instanceof Error ? err.message : JSON.stringify(err);
  const text = (raw ?? 'unknown error').replace(
    /(password=|MASTER_PASSWORD = )\S+/g,
    '$1***',
  );
  if (
    /timeout|could not connect|Connection refused|could not translate host|Can't connect|Unknown server host/i.test(
      text,
    )
  ) {
    return `The source did not answer from the cluster (${text.trim().slice(0, 300)}). Check that it accepts connections from the cluster's address, and that the cluster's outbound rules allow its port.`;
  }
  return text.trim().slice(0, 600);
}
