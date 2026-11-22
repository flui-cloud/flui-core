import { migrations } from './index';
import { AppPorts1790000000051 } from './1790000000051-AppPorts';

describe('AppPorts1790000000051', () => {
  it('only adds its own columns', async () => {
    const sql: string[] = [];
    await new AppPorts1790000000051().up({
      query: async (q: string) => {
        sql.push(q);
      },
    } as never);
    expect(sql).toEqual([
      'ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "extraPorts" json',
      'ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "udpPorts" json',
    ]);
  });

  it('is registered', () => {
    expect(migrations).toContain(AppPorts1790000000051);
  });
});
