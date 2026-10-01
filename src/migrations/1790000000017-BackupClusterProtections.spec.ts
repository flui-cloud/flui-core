import { BackupClusterProtections1790000000017 } from './1790000000017-BackupClusterProtections';
import { migrations } from './index';

describe('BackupClusterProtections1790000000017', () => {
  it('creates one protection row per cluster, and is registered', async () => {
    const queries: string[] = [];
    await new BackupClusterProtections1790000000017().up({
      query: async (sql: string) => {
        queries.push(sql);
      },
    } as never);
    expect(queries[0]).toContain(
      'CREATE TABLE IF NOT EXISTS "backup_cluster_protections"',
    );
    expect(queries[0]).toContain(`"applications" jsonb NOT NULL DEFAULT '{}'`);
    expect(queries[1]).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "uq_backup_cluster_protections_cluster"',
    );
    expect(migrations).toContain(BackupClusterProtections1790000000017);
  });
});
