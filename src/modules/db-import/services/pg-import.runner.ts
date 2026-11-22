import { Injectable } from '@nestjs/common';
import { DbPodExecService } from '../../db-lifecycle/services/db-pod-exec.service';
import {
  conninfoWithPassword,
  inOneTransaction,
  parseSourcePreflight,
  replicaIdentitySql,
  SOURCE_PREFLIGHT_SQL,
  SOURCE_SEQUENCES_SQL,
  sourceLagSql,
  sourcePreflightProblems,
  sqlLiteral,
  subscriptionStateSql,
} from '../../db-lifecycle/utils/external-pg.core';
import { ExternalPgService } from './external-pg.service';
import {
  ImportContext,
  ImportProgress,
  ImportRunner,
  twiceQuiet,
} from './import-runner';

const USER_TABLES_SQL = String.raw`SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'flui\_%';`;

/** PostgreSQL to PostgreSQL through logical replication: a publication there, a subscription here. */
@Injectable()
export class PgImportRunner implements ImportRunner {
  constructor(
    private readonly exec: DbPodExecService,
    private readonly external: ExternalPgService,
  ) {}

  async copy({ row, target, password }: ImportContext): Promise<string | null> {
    const name = row.objectName;
    const preflight = parseSourcePreflight(
      await this.external.query(
        target,
        row.source,
        password,
        SOURCE_PREFLIGHT_SQL,
      ),
    );
    const problems = sourcePreflightProblems(preflight);
    if (problems.length) return problems.join(' ');
    const existing = Number(
      (await this.exec.execSql(target, USER_TABLES_SQL)).trim(),
    );
    if (existing > 0) {
      return `The Flui database already holds ${existing} table(s). Import into an empty database, so nothing is overwritten.`;
    }

    const schema = await this.external.schemaDump(target, row.source, password);
    if (schema.trim()) {
      await this.exec.execSqlStream(target, inOneTransaction(schema));
    }
    if (preflight.tablesWithoutKey.length) {
      await this.external.query(
        target,
        row.source,
        password,
        replicaIdentitySql(preflight.tablesWithoutKey, 'FULL'),
      );
      row.tablesWithoutKey = preflight.tablesWithoutKey;
    }
    await this.external.query(
      target,
      row.source,
      password,
      `DROP PUBLICATION IF EXISTS ${name};\nCREATE PUBLICATION ${name} FOR ALL TABLES;`,
    );
    await this.exec.execSql(
      target,
      [
        `CREATE SUBSCRIPTION ${name}`,
        `  CONNECTION ${sqlLiteral(conninfoWithPassword(row.source, password))}`,
        `  PUBLICATION ${name}`,
        `  WITH (copy_data = true, create_slot = true, slot_name = ${sqlLiteral(name)});`,
      ].join('\n'),
    );
    row.tablesTotal = preflight.tables;
    row.tablesCopied = 0;
    return null;
  }

  async progress(ctx: ImportContext): Promise<ImportProgress> {
    const { row, target } = ctx;
    const [notReady, total] = (
      await this.exec.execSql(target, subscriptionStateSql(row.objectName))
    )
      .trim()
      .split('|')
      .map(Number);
    let streaming = false;
    if (Number.isFinite(total) && total > 0) {
      row.tablesTotal = total;
      row.tablesCopied = total - notReady;
      streaming = notReady === 0;
    }
    row.lagBytes = await this.lag(ctx);
    return { streaming, lagSeconds: null };
  }

  caughtUp(ctx: ImportContext): Promise<boolean> {
    return twiceQuiet(async () => (await this.lag(ctx)) === '0');
  }

  async finish(ctx: ImportContext): Promise<string[]> {
    const { row, target, password } = ctx;
    const setvals = await this.external.query(
      target,
      row.source,
      password,
      SOURCE_SEQUENCES_SQL,
    );
    if (setvals.trim()) await this.exec.execSql(target, setvals);
    await this.exec.execSql(target, `DROP SUBSCRIPTION ${row.objectName};`);
    return this.cleanSource(ctx);
  }

  async cleanUp(ctx: ImportContext): Promise<string[]> {
    const { row, target } = ctx;
    const notes: string[] = [];
    try {
      await this.exec.execSql(
        target,
        `DROP SUBSCRIPTION IF EXISTS ${row.objectName};`,
      );
    } catch {
      try {
        await this.exec.execSql(
          target,
          [
            `ALTER SUBSCRIPTION ${row.objectName} DISABLE;`,
            `ALTER SUBSCRIPTION ${row.objectName} SET (slot_name = NONE);`,
            `DROP SUBSCRIPTION ${row.objectName};`,
          ].join('\n'),
        );
      } catch {
        notes.push(
          `The subscription ${row.objectName} could not be removed from the Flui database.`,
        );
      }
    }
    return [...notes, ...(await this.cleanSource(ctx))];
  }

  private async lag({
    row,
    target,
    password,
  }: ImportContext): Promise<string | null> {
    const out = (
      await this.external.query(
        target,
        row.source,
        password,
        sourceLagSql(row.objectName),
      )
    ).trim();
    return out && out !== '-1' ? out : null;
  }

  private async cleanSource({
    row,
    target,
    password,
  }: ImportContext): Promise<string[]> {
    try {
      await this.external.query(
        target,
        row.source,
        password,
        [
          `DROP PUBLICATION IF EXISTS ${row.objectName};`,
          `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name = ${sqlLiteral(row.objectName)} AND NOT active;`,
          replicaIdentitySql(row.tablesWithoutKey, 'DEFAULT'),
        ].join('\n'),
      );
      return [];
    } catch {
      const identity = row.tablesWithoutKey.length
        ? `, and set REPLICA IDENTITY DEFAULT back on ${row.tablesWithoutKey.join(', ')}`
        : '';
      return [
        `On the source, remove the publication and the replication slot named ${row.objectName} by hand${identity}: an unused slot keeps the source from freeing its WAL.`,
      ];
    }
  }
}
