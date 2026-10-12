jest.mock('@kubernetes/client-node', () => ({}));

import { reloadHba } from './hba-reload';
import { HBA_ERRORS_SQL } from './db-write-fence.service';

describe('reloadHba', () => {
  const db = { appId: 'a1' } as any;

  it('reloads only when pg_hba.conf has no error line', async () => {
    const sqls: string[] = [];
    const exec = {
      execSql: jest.fn(async (_t: unknown, q: string) => {
        sqls.push(q);
        return q === HBA_ERRORS_SQL ? '0\n' : '';
      }),
    };
    await reloadHba(exec, db);
    expect(sqls).toEqual([HBA_ERRORS_SQL, 'SELECT pg_reload_conf();']);
  });

  it.each([
    ['2', '2 error line(s)'],
    ['x', 'unreadable error line(s)'],
  ])('refuses to reload with %s errors', async (count, msg) => {
    const exec = { execSql: jest.fn(async () => count) };
    await expect(reloadHba(exec, db)).rejects.toThrow(msg);
    expect(exec.execSql).toHaveBeenCalledTimes(1);
  });
});
