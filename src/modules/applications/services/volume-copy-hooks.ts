/**
 * What an engine can be asked to do so its files are safe to copy while it runs.
 *
 * A hook is not a way to make a live file copy "probably fine". It is the
 * engine's own mechanism for putting a consistent image on disk, invoked
 * through the engine, and the copy that follows reads only that image. Where no
 * such mechanism exists, there is no hook — the volume is skipped and reported,
 * which is the honest outcome.
 *
 * Every script runs inside the workload's own container and uses that
 * container's environment for credentials. Flui therefore never reads, stores
 * or passes an engine password to run a backup: the secret stays where it was
 * already trusted, and a hook cannot become a way to exfiltrate one.
 */
export interface VolumeCopyHook {
  /** Matches the catalog-declared `flui.cloud/db-engine` label. */
  engine: string;
  /** Recorded on the artifact so a reader knows what made the copy safe. */
  name: string;
  /** Why this engine is safe to copy once the script has run. */
  rationale: string;
  /**
   * A `sh` script run in the container. Must exit non-zero if it cannot leave a
   * consistent image on disk — a hook that fails quietly is worse than none,
   * because the copy that follows would be recorded as consistent.
   */
  script: string;
}

/**
 * `BGSAVE` forks and writes the RDB to a temporary file, then renames it over
 * `dump.rdb`. The rename is atomic, so a reader either sees the whole old file
 * or the whole new one — never a half-written one. Waiting for
 * `rdb_bgsave_in_progress` to clear and then checking `rdb_last_bgsave_status`
 * is what turns "we asked" into "it is on disk".
 *
 * This is also the clearest case for why a hook is not a nicety. Default
 * persistence saves after 3600 seconds and one change, so a freshly written
 * store holds its data only in memory: measured on a live Valkey, five keys
 * were present and the volume contained **no files at all**. Copying it without
 * the hook yields an empty artifact that every listing calls a backup.
 *
 * `--no-auth-warning` only silences the notice about `-a` on the command line;
 * the password never leaves the container either way.
 */
function rdbHook(
  engine: string,
  cli: string,
  passwordVar: string,
): VolumeCopyHook {
  return {
    engine,
    name: `${engine}-bgsave`,
    rationale: `${engine} wrote a fresh RDB and renamed it into place, so the file on disk is a whole snapshot`,
    script: [
      'set -e',
      `R="${cli} -a $${passwordVar} --no-auth-warning"`,
      // A save already running is one somebody else started; its result is
      // still a consistent file, so wait for it rather than forking a second.
      String.raw`LAST=$($R INFO persistence | tr -d "\r" | grep ^rdb_last_save_time: | cut -d: -f2)`,
      '$R BGSAVE >/dev/null',
      'for i in $(seq 1 120); do',
      String.raw`  P=$($R INFO persistence | tr -d "\r" | grep ^rdb_bgsave_in_progress: | cut -d: -f2)`,
      '  [ "$P" = "0" ] && break',
      '  sleep 1',
      'done',
      String.raw`S=$($R INFO persistence | tr -d "\r" | grep ^rdb_last_bgsave_status: | cut -d: -f2)`,
      String.raw`N=$($R INFO persistence | tr -d "\r" | grep ^rdb_last_save_time: | cut -d: -f2)`,
      '[ "$S" = "ok" ] || { echo "BGSAVE reported $S" >&2; exit 1; }',
      // A status of ok with an unchanged timestamp means nothing was written in
      // this window, so the copy would be of an older image than it claims.
      '[ "$N" != "$LAST" ] || { echo "BGSAVE did not produce a new save" >&2; exit 1; }',
      'echo FLUI_HOOK_OK',
    ].join('\n'),
  };
}

const REDIS_BGSAVE = rdbHook('redis', 'redis-cli', 'REDIS_PASSWORD');

/**
 * A Redis fork, but not a drop-in for this purpose: the image ships
 * `valkey-cli` with **no** `redis-cli` symlink, and the password arrives as
 * `VALKEY_PASSWORD`. Registering the Redis hook under this engine by
 * similarity would have produced a hook that fails on every run — which the
 * refusal turns into "no copy taken", so it would have been loud rather than
 * silent, but wrong all the same. Both names were read off a live install.
 */
const VALKEY_BGSAVE = rdbHook('valkey', 'valkey-cli', 'VALKEY_PASSWORD');

/**
 * Keyed on the engine the catalog declared, which is the one place this label
 * is the right key: the population that carries it is exactly the population
 * Flui installed and can therefore run a known command against. A raw container
 * someone brought themselves carries no label, finds no hook, and falls through
 * to being skipped — which is correct, because Flui does not know what it is.
 *
 * Engines are added here only once their hook has been run against a real
 * instance. An unverified hook is a claim of consistency nobody checked, and
 * that is the failure this whole area exists to stop making.
 */
export const VOLUME_COPY_HOOKS: ReadonlyMap<string, VolumeCopyHook> = new Map([
  [REDIS_BGSAVE.engine, REDIS_BGSAVE],
  [VALKEY_BGSAVE.engine, VALKEY_BGSAVE],
]);

export function hookForEngine(
  engine: string | undefined | null,
): VolumeCopyHook | undefined {
  return engine ? VOLUME_COPY_HOOKS.get(engine) : undefined;
}
