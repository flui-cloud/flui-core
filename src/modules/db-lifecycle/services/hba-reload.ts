import type { DbPodExecService, ResolvedApp } from './db-pod-exec.service';
import { HBA_ERRORS_SQL } from './db-write-fence.service';

export async function reloadHba(
  exec: Pick<DbPodExecService, 'execSql'>,
  t: ResolvedApp,
): Promise<void> {
  const errors = Number((await exec.execSql(t, HBA_ERRORS_SQL)).trim());
  if (errors !== 0) {
    throw new Error(
      `pg_hba.conf of ${t.appId} has ${Number.isNaN(errors) ? 'unreadable' : errors} error line(s); not reloading`,
    );
  }
  await exec.execSql(t, 'SELECT pg_reload_conf();');
}
