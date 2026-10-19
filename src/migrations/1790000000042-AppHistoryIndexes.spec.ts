import { migrations } from './index';
import { AppHistoryIndexes1790000000042 } from './1790000000042-AppHistoryIndexes';

const capture = async (run: (q: never) => Promise<void>) => {
  const sql: string[] = [];
  await run({ query: async (q: string) => void sql.push(q) } as never);
  return sql;
};

describe('AppHistoryIndexes1790000000042', () => {
  it('indexes revisions by application and time, resources by application', async () => {
    const sql = await capture((q) =>
      new AppHistoryIndexes1790000000042().up(q),
    );
    expect(sql).toEqual([
      'CREATE INDEX IF NOT EXISTS "IDX_app_revisions_application_created" ON "app_revisions" ("applicationId", "createdAt")',
      'CREATE INDEX IF NOT EXISTS "IDX_app_resources_application" ON "app_resources" ("applicationId")',
    ]);
  });

  it('drops both indexes', async () => {
    const sql = await capture((q) =>
      new AppHistoryIndexes1790000000042().down(q),
    );
    expect(sql).toEqual([
      'DROP INDEX IF EXISTS "IDX_app_resources_application"',
      'DROP INDEX IF EXISTS "IDX_app_revisions_application_created"',
    ]);
  });

  it('runs right after the control peer per node', () => {
    const at = migrations.indexOf(AppHistoryIndexes1790000000042);
    expect(migrations[at - 1].name).toBe('ControlPeerPerNode1790000000041');
  });
});
