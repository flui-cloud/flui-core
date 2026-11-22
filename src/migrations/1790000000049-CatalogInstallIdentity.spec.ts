import { migrations } from './index';
import { CatalogInstallIdentity1790000000049 } from './1790000000049-CatalogInstallIdentity';

describe('CatalogInstallIdentity1790000000049', () => {
  it('only adds a nullable column, so no existing install changes', async () => {
    const sql: string[] = [];
    await new CatalogInstallIdentity1790000000049().up({
      query: async (q: string) => {
        sql.push(q);
      },
    } as never);
    expect(sql).toEqual([
      'ALTER TABLE "catalog_installs" ADD COLUMN IF NOT EXISTS "identityInstallId" uuid',
    ]);
  });

  it('runs right after the app identity links migration', () => {
    const at = migrations.indexOf(CatalogInstallIdentity1790000000049);
    expect(migrations[at - 1].name).toBe('AppIdentityLinks1790000000048');
  });
});
