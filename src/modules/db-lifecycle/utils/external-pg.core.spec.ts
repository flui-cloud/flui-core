import {
  conninfoWithPassword,
  externalPgSourceProblems,
  importObjectNames,
  parseSourcePreflight,
  psqlOnSource,
  replicaIdentitySql,
  sourcePreflightProblems,
  sqlLiteral,
} from './external-pg.core';

const source = {
  host: 'db.example.com',
  port: 5432,
  database: 'shop',
  user: 'replicator',
  sslmode: 'require' as const,
};

describe('an external PostgreSQL source', () => {
  it('accepts a plain host, port, database and user', () => {
    expect(externalPgSourceProblems(source)).toEqual([]);
    expect(externalPgSourceProblems({ ...source, host: '192.0.2.10' })).toEqual(
      [],
    );
  });

  it('refuses anything that could break out of a shell word or a conninfo', () => {
    expect(
      externalPgSourceProblems({
        host: "db'; rm -rf /",
        port: 0,
        database: 'shop db',
        user: "x' password=y",
        sslmode: 'allow' as never,
      }),
    ).toHaveLength(5);
  });

  it('reads the password from stdin, never from the command line', () => {
    const cmd = psqlOnSource(source);
    expect(
      cmd.startsWith('IFS= read -r PGPASSWORD && export PGPASSWORD && psql'),
    ).toBe(true);
    expect(cmd).not.toContain('password');
  });

  it('quotes the password for libpq inside the subscription, and the whole for SQL', () => {
    const info = conninfoWithPassword(source, "p'a\\ss");
    expect(info.endsWith("password='p\\'a\\\\ss'")).toBe(true);
    expect(sqlLiteral(info)).toContain("password=''p\\''a\\\\ss''");
  });

  it('turns the preflight rows into what blocks the import', () => {
    const p = parseSourcePreflight(
      [
        'version|160004',
        'wal_level|replica',
        'replication|false',
        'slots_free|0',
        'tables|12',
        'no_pk|public.events',
        'no_pk|audit.log',
      ].join('\n'),
    );
    expect(p.tablesWithoutKey).toEqual(['public.events', 'audit.log']);
    expect(p.tables).toBe(12);
    expect(sourcePreflightProblems(p)).toHaveLength(3);
    expect(
      sourcePreflightProblems({
        ...p,
        walLevel: 'logical',
        canReplicate: true,
        freeSlots: 2,
      }),
    ).toEqual([]);
    expect(
      sourcePreflightProblems({
        ...p,
        versionNum: 180001,
        walLevel: 'logical',
        canReplicate: true,
        freeSlots: 2,
      }),
    ).toHaveLength(1);
  });

  it('names its objects after the import and can undo the replica identity it set', () => {
    expect(importObjectNames('3f2a9c10-aaaa-bbbb-cccc-000000000000')).toEqual({
      publication: 'flui_import_3f2a9c10aaaa',
      subscription: 'flui_import_3f2a9c10aaaa',
      slot: 'flui_import_3f2a9c10aaaa',
    });
    expect(replicaIdentitySql(['public.events'], 'FULL')).toBe(
      'ALTER TABLE public.events REPLICA IDENTITY FULL;',
    );
  });
});
