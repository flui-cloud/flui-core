import { Injectable } from '@nestjs/common';
import { ResolvedApp } from '../../db-lifecycle/services/db-pod-exec.service';
import { sqlLiteral } from '../../db-lifecycle/utils/external-pg.core';
import {
  MARIADB_SOURCE_PREFLIGHT_SQL,
  mariadbCopyIntoTarget,
  mariadbOnSource,
  mariadbPreflightProblems,
  parseBinlogCoordinates,
  parseMariadbPreflight,
  parseMasterStatus,
  parseReplicaStatus,
  ReplicaStatus,
  replicaServerId,
  startReplicationSql,
  STOP_REPLICATION_SQL,
} from '../../db-lifecycle/utils/external-mariadb.core';
import { ExternalPgService } from './external-pg.service';
import {
  ImportContext,
  ImportProgress,
  ImportRunner,
  twiceQuiet,
} from './import-runner';

const ROOT_CLIENT = 'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" -N -B';

/**
 * MariaDB to MariaDB: a consistent dump streamed straight into the target,
 * then the target replicates the source's binary log from the position the
 * dump was taken at. Nothing is added on the source.
 */
@Injectable()
export class MariadbImportRunner implements ImportRunner {
  constructor(private readonly pods: ExternalPgService) {}

  async copy(ctx: ImportContext): Promise<string | null> {
    const { row, target, password, targetDatabase } = ctx;
    const preflight = parseMariadbPreflight(
      await this.onSource(ctx, MARIADB_SOURCE_PREFLIGHT_SQL),
    );
    const problems = mariadbPreflightProblems(preflight);
    if (problems.length) return problems.join(' ');
    const existing = Number(
      (
        await this.onTarget(
          target,
          `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = ${sqlLiteral(targetDatabase)};`,
        )
      ).trim(),
    );
    if (existing > 0) {
      return `The Flui database already holds ${existing} table(s). Import into an empty database, so nothing is overwritten.`;
    }

    const coords = parseBinlogCoordinates(
      await this.pods.run(
        target,
        mariadbCopyIntoTarget(row.source, targetDatabase),
        `${password}\n`,
        'bash',
      ),
    );
    if (!coords) {
      throw new Error(
        'The copy finished without the binary log position it was taken at',
      );
    }
    await this.onTarget(
      target,
      startReplicationSql(
        row.source,
        password,
        coords,
        targetDatabase,
        replicaServerId(preflight.serverId, Date.now()),
      ),
    );
    row.tablesTotal = preflight.tables;
    row.tablesCopied = preflight.tables;
    return null;
  }

  async progress({ row, target }: ImportContext): Promise<ImportProgress> {
    const status = await this.replicaStatus(target);
    if (status?.error && !(status.ioRunning && status.sqlRunning)) {
      row.detail = `Replication stopped: ${status.error}`;
    }
    return {
      streaming: !!status?.ioRunning && !!status.sqlRunning,
      lagSeconds: status?.secondsBehind ?? null,
    };
  }

  caughtUp(ctx: ImportContext): Promise<boolean> {
    return twiceQuiet(async () => {
      const source = parseMasterStatus(
        await this.onSource(ctx, 'SHOW MASTER STATUS;'),
      );
      const replica = await this.replicaStatus(ctx.target);
      if (replica?.error && !replica.sqlRunning) {
        throw new Error(`Replication stopped: ${replica.error}`);
      }
      return (
        !!source &&
        !!replica?.sqlRunning &&
        replica.execFile === source.file &&
        replica.execPosition === source.position
      );
    });
  }

  async finish(ctx: ImportContext): Promise<string[]> {
    await this.onTarget(ctx.target, STOP_REPLICATION_SQL);
    return [];
  }

  async cleanUp(ctx: ImportContext): Promise<string[]> {
    try {
      await this.onTarget(ctx.target, STOP_REPLICATION_SQL);
      return [];
    } catch {
      return [
        'Replication could not be stopped on the Flui database: run STOP SLAVE; RESET SLAVE ALL; on it.',
      ];
    }
  }

  private onSource(ctx: ImportContext, sql: string): Promise<string> {
    return this.pods.run(
      ctx.target,
      mariadbOnSource(ctx.row.source),
      `${ctx.password}\n${sql}`,
    );
  }

  private onTarget(target: ResolvedApp, sql: string): Promise<string> {
    return this.pods.run(target, ROOT_CLIENT, sql);
  }

  private async replicaStatus(
    target: ResolvedApp,
  ): Promise<ReplicaStatus | null> {
    return parseReplicaStatus(
      await this.pods.run(
        target,
        String.raw`mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" -e "SHOW SLAVE STATUS\G"`,
        '',
      ),
    );
  }
}
