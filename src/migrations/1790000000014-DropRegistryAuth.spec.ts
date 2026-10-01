import { DropRegistryAuth1790000000014 } from './1790000000014-DropRegistryAuth';

describe('DropRegistryAuth1790000000014', () => {
  it('removes every credential field from applications and from revision snapshots, and only where one is present', async () => {
    const queries: string[] = [];
    await new DropRegistryAuth1790000000014().up({
      query: async (sql: string) => {
        queries.push(sql);
      },
    } as never);

    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain('UPDATE "applications" SET "sourceConfig"');
    expect(queries[1]).toContain(
      'UPDATE "app_revisions" SET "sourceConfigSnapshot"',
    );
    for (const sql of queries) {
      expect(sql).toContain(
        "- 'registryAuth' - 'registryAuthEncrypted' - 'hasRegistryAuth'",
      );
      expect(sql).toContain(
        "?| array['registryAuth', 'registryAuthEncrypted', 'hasRegistryAuth']",
      );
    }
  });
});
