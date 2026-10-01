import { DefaultBackupSchedules1790000000016 } from './1790000000016-DefaultBackupSchedules';
import { DEFAULT_BACKUP_SCHEDULE } from '../modules/backups/utils/default-schedule.util';

describe('DefaultBackupSchedules1790000000016', () => {
  const run = async () => {
    const queries: string[] = [];
    await new DefaultBackupSchedules1790000000016().up({
      query: async (sql: string) => {
        queries.push(sql);
      },
    } as never);
    return queries;
  };

  it('gives the schedule a new policy of the same kind gets', async () => {
    const [sql] = await run();
    expect(sql).toContain(
      `WHEN 'platform' THEN '${DEFAULT_BACKUP_SCHEDULE.platform}'`,
    );
    expect(sql).toContain(
      `WHEN 'database' THEN '${DEFAULT_BACKUP_SCHEDULE.continuousDatabase}'`,
    );
    expect(sql).toContain(
      `WHEN 'volume_copy' THEN '${DEFAULT_BACKUP_SCHEDULE.volumeCopy}'`,
    );
  });

  it('touches only active policies without a schedule, and never a dump or a cluster policy', async () => {
    const queries = await run();
    expect(queries).toHaveLength(1);
    const [sql] = queries;
    expect(sql).toContain(`"status" = 'active'`);
    expect(sql).toContain(
      `("cronSchedule" IS NULL OR btrim("cronSchedule") = '')`,
    );
    expect(sql).toContain(`NOT LIKE '%-dump'`);
    expect(sql).not.toContain(`'volume'`);
    expect(sql).not.toContain('nextRunAt');
  });
});
