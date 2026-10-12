import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DbFenceRecord } from '../entities/db-migration.entity';
import { DbPodExecService, ResolvedApp } from './db-pod-exec.service';

const VERIFY_TIMEOUT_MS = 10_000;
const VERIFY_POLL_MS = 500;
const MARKER_RE = /^flui:fence:[a-z0-9]+$/;

export const TERMINATE_TCP_CLIENTS_SQL = `SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE backend_type = 'client backend' AND client_addr IS NOT NULL AND pid <> pg_backend_pid();`;

// A hostssl line while TLS is off is reported but still loaded; any other error
// means a reload would keep the old rules.
export const HBA_ERRORS_SQL = `SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL AND error NOT LIKE 'hostssl record cannot match%';`;

export const FENCE_VERIFY_SQL = [
  `SELECT (SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend' AND client_addr IS NOT NULL)`,
  ` || '|' || (SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend' AND backend_xid IS NOT NULL AND pid <> pg_backend_pid())`,
  ` || '|' || (SELECT count(*) FROM (SELECT type, database, user_name, auth_method FROM pg_hba_file_rules ORDER BY line_number LIMIT 2) r`,
  ` WHERE r.type = 'host' AND r.auth_method = 'reject' AND r.database = '{all}' AND r.user_name = '{all}');`,
].join('');

/** Prints the checksum of the file without our block, so a re-run keeps the original. */
export function fenceScript(marker: string): string {
  assertMarker(marker);
  const begin = `# ${marker}:begin`;
  const end = `# ${marker}:end`;
  return [
    'set -e',
    'HBA="$PGDATA/pg_hba.conf"',
    `BEFORE=$(sed '/^${begin}$/,/^${end}$/d' "$HBA" | sha256sum | cut -d' ' -f1)`,
    `if ! grep -qx '${begin}' "$HBA"; then`,
    String.raw`  { printf '${begin}\nhost all all 0.0.0.0/0 reject\nhost all all ::/0 reject\n${end}\n'`,
    '    cat "$HBA"; } > "$HBA.flui" && chown postgres:postgres "$HBA.flui" && chmod 600 "$HBA.flui" && mv "$HBA.flui" "$HBA"',
    'fi',
    'echo "FLUI_FENCE_BEFORE=$BEFORE"',
  ].join('\n');
}

export function unfenceScript(marker: string): string {
  assertMarker(marker);
  return [
    'set -e',
    'HBA="$PGDATA/pg_hba.conf"',
    `sed -i '/^# ${marker}:begin$/,/^# ${marker}:end$/d' "$HBA"`,
    'chown postgres:postgres "$HBA"',
    'echo "FLUI_FENCE_AFTER=$(sha256sum "$HBA" | cut -d\' \' -f1)"',
  ].join('\n');
}

function assertMarker(marker: string): void {
  if (!MARKER_RE.test(marker)) {
    throw new BadRequestException(`Not a fence marker: ${marker}`);
  }
}

function field(out: string, name: string): string | undefined {
  return out
    .split('\n')
    .find((l) => l.startsWith(`${name}=`))
    ?.slice(name.length + 1)
    .trim();
}

/**
 * The hard write fence: `pg_hba.conf` rejects every TCP client, the reload
 * makes it effective, and every TCP session is terminated. The app's role is
 * a superuser, which no SQL-level fence holds; a superuser that never gets a
 * session writes nothing. Files do not travel in WAL, so the fence stays on
 * the source. Flui's exec and pgBackRest use the local socket, and
 * replication connections never match the database keyword `all`.
 */
@Injectable()
export class DbWriteFenceService {
  private readonly logger = new Logger(DbWriteFenceService.name);

  constructor(private readonly exec: DbPodExecService) {}

  /**
   * `persist` is called before the reload, so a crash after the reload still
   * leaves a record an abort can undo, and again once the fence is verified.
   */
  async fence(
    t: ResolvedApp,
    marker: string,
    persist: (record: DbFenceRecord) => Promise<void>,
  ): Promise<DbFenceRecord> {
    const out = await this.exec.execRaw(t, fenceScript(marker));
    const before = field(out, 'FLUI_FENCE_BEFORE');
    if (!before) {
      throw new Error(`Fence on ${t.appId}: pg_hba.conf checksum not reported`);
    }
    const record: DbFenceRecord = {
      method: 'pg_hba',
      marker,
      hbaSha256Before: before,
      appliedAt: new Date().toISOString(),
      releasedAt: null,
      releaseNote: null,
    };
    await persist(record);

    await this.assertParses(t);
    await this.exec.execSql(t, 'SELECT pg_reload_conf();');
    record.terminatedSessions =
      Number((await this.exec.execSql(t, TERMINATE_TCP_CLIENTS_SQL)).trim()) ||
      0;

    const deadline = Date.now() + VERIFY_TIMEOUT_MS;
    let last = '';
    for (;;) {
      last = (await this.exec.execSql(t, FENCE_VERIFY_SQL)).trim();
      if (last === '0|0|2') break;
      if (Date.now() > deadline) {
        throw new Error(
          `Fence on ${t.appId} not effective (tcp sessions|open writes|reject rules = ${last})`,
        );
      }
      await new Promise((r) => setTimeout(r, VERIFY_POLL_MS));
    }
    await persist(record);
    this.logger.log(
      `[db-fence] ${t.appId} fenced (${marker}), ${record.terminatedSessions} session(s) terminated`,
    );
    return record;
  }

  /**
   * Removes exactly our block. Someone else's edit made meanwhile is kept and
   * reported, never reverted.
   */
  async unfence(t: ResolvedApp, record: DbFenceRecord): Promise<DbFenceRecord> {
    const out = await this.exec.execRaw(t, unfenceScript(record.marker));
    const after = field(out, 'FLUI_FENCE_AFTER');
    await this.assertParses(t);
    await this.exec.execSql(t, 'SELECT pg_reload_conf();');
    const released: DbFenceRecord = {
      ...record,
      releasedAt: new Date().toISOString(),
      releaseNote:
        after === record.hbaSha256Before
          ? null
          : `pg_hba.conf changed while fenced (now ${after ?? 'unknown'}); the fence block was removed, other edits kept`,
    };
    const note = released.releaseNote ? ` — ${released.releaseNote}` : '';
    this.logger.log(`[db-fence] ${t.appId} unfenced (${record.marker})${note}`);
    return released;
  }

  async isFenced(t: ResolvedApp, marker: string): Promise<boolean> {
    assertMarker(marker);
    const present = await this.exec.execRaw(
      t,
      `grep -qx '# ${marker}:begin' "$PGDATA/pg_hba.conf" && echo yes || echo no`,
    );
    if (present.trim() !== 'yes') return false;
    const last = (await this.exec.execSql(t, FENCE_VERIFY_SQL)).trim();
    const errors = Number((await this.exec.execSql(t, HBA_ERRORS_SQL)).trim());
    return errors === 0 && last.endsWith('|2');
  }

  /** A reload with a parse error silently keeps the old rules. */
  private async assertParses(t: ResolvedApp): Promise<void> {
    const errors = Number((await this.exec.execSql(t, HBA_ERRORS_SQL)).trim());
    if (errors !== 0) {
      throw new Error(
        `pg_hba.conf of ${t.appId} has ${Number.isNaN(errors) ? 'unreadable' : errors} error line(s); not reloading`,
      );
    }
  }
}
