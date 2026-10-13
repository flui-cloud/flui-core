import { migrations } from './index';
import { RegistrySettings1790000000033 } from './1790000000033-RegistrySettings';

describe('RegistrySettings1790000000033', () => {
  it('creates an empty settings table, so the install-time choice still holds', async () => {
    const sql: string[] = [];
    await new RegistrySettings1790000000033().up({
      query: async (q: string) => {
        sql.push(q);
      },
    } as never);
    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain('CREATE TABLE IF NOT EXISTS "registry_settings"');
    expect(sql[0]).toContain('"mode" character varying(8) NOT NULL');
    expect(sql[0]).toContain('"storageBackend" character varying(16) NOT NULL');
    expect(sql.join('\n')).not.toMatch(/INSERT/);
  });

  it('drops only its own table', async () => {
    const sql: string[] = [];
    await new RegistrySettings1790000000033().down({
      query: async (q: string) => {
        sql.push(q);
      },
    } as never);
    expect(sql).toEqual(['DROP TABLE IF EXISTS "registry_settings"']);
  });

  it('runs last, after the pooler cut', () => {
    expect(migrations[migrations.length - 1]).toBe(
      RegistrySettings1790000000033,
    );
    expect(migrations[migrations.length - 2].name).toBe(
      'DbPoolerCut1790000000032',
    );
  });
});
