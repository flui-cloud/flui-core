#!/bin/bash
#
# Rebuilds a MariaDB data directory from a base backup plus its binary logs,
# stopping at a chosen moment.
#
# Runs as an init container beside a fresh MariaDB, before the server starts:
# by the time the database boots, the volume already holds the restored state.
# That mirrors what `flui-entrypoint.sh` does for Postgres, and it is why the
# server's own image needs no restore logic at all.
#
# It is present on every catalog MariaDB and does nothing on almost all of
# them. Being born with it is what makes a restore an ordinary install with
# different environment, instead of a special manifest nobody has exercised
# until the day it is needed.
#
# The rule this script exists to enforce: **refuse rather than produce a
# database that is quietly wrong.** A missing binary log in the middle of the
# sequence, a base whose position cannot be read, a target outside the window —
# each of those can be replayed *past* without any error, and the result looks
# like a successful restore holding data that never existed in that shape.

set -uo pipefail

# Everything here speaks UTC: the caller passes a UTC instant, `--stop-datetime`
# is read in the server's own zone, and the base is chosen by comparing
# rclone's rendering of an object's time against that instant. One zone, so
# none of those three comparisons can quietly shift the moment being restored.
export TZ=UTC

log() { printf '%s [restore] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "REFUSED: $*"; exit 1; }

# Not in restore mode, which is the normal case. Exiting zero and silent-ish
# keeps this container off the critical path of every ordinary install.
if [ "${FLUI_MARIADB_RESTORE:-}" != "1" ]; then
  log "not a restore; leaving the data directory to the server"
  exit 0
fi

: "${FLUI_MARIADB_S3_BUCKET:?the repository bucket to restore from}"
: "${FLUI_MARIADB_S3_PATH:?the repository path to restore from}"
DATADIR="${FLUI_MARIADB_DATADIR:-/var/lib/mysql}"
TARGET_TIME="${FLUI_MARIADB_TARGET_TIME:-}"
BASE_LABEL="${FLUI_MARIADB_BASE_LABEL:-}"
WORK="${FLUI_MARIADB_WORK_DIR:-/var/tmp/flui-restore}"

# rclone is configured from the fields Flui passed rather than from a remote
# string, so every value it holds carries the `FLUI_MARIADB_` prefix that the
# control plane strips again once the restore is done. A credential under a
# name the strip step does not know would outlive the boot that needed it.
export RCLONE_CONFIG_FLUI_TYPE=s3
export RCLONE_CONFIG_FLUI_PROVIDER=Other
export RCLONE_CONFIG_FLUI_ACCESS_KEY_ID="${FLUI_MARIADB_S3_KEY:-}"
export RCLONE_CONFIG_FLUI_SECRET_ACCESS_KEY="${FLUI_MARIADB_S3_KEY_SECRET:-}"
export RCLONE_CONFIG_FLUI_ENDPOINT="${FLUI_MARIADB_S3_ENDPOINT:-}"
export RCLONE_CONFIG_FLUI_REGION="${FLUI_MARIADB_S3_REGION:-auto}"
export RCLONE_CONFIG_FLUI_FORCE_PATH_STYLE="${FLUI_MARIADB_S3_FORCE_PATH_STYLE:-false}"

REPO="flui:${FLUI_MARIADB_S3_BUCKET}/${FLUI_MARIADB_S3_PATH%/}"
BASE_REMOTE="$REPO/base"
LOG_REMOTE="$REPO/binlog"

# Already restored, or a normal restart of a pod that was restored earlier.
# Overwriting a live data directory because a container restarted would be the
# worst possible reading of "restore mode".
if [ -f "$DATADIR/.flui-restored" ]; then
  log "this volume was already restored; leaving it untouched"
  exit 0
fi
if [ -n "$(ls -A "$DATADIR" 2>/dev/null)" ]; then
  die "the data directory is not empty. A restore writes a whole data directory and will not overwrite an existing one."
fi

rm -rf "$WORK"; mkdir -p "$WORK"
# The temporary server runs as `mysql` — it refuses to run as root — so it has
# to be able to bind its socket in here. Without this it aborts on
# `Bind on unix socket: Permission denied` before anything is replayed.
chown mysql:mysql "$WORK" 2>/dev/null || chmod 0777 "$WORK"

# ── the base ────────────────────────────────────────────────────────────────

# When a base finished, from the repository. `mariadb-backup` records its
# position at the END of the backup, so the moment the object landed is the
# earliest instant that base can be restored to.
base_times() {
  rclone lsf --format "tp" -R "$BASE_REMOTE/" 2>/dev/null | grep '/binlog_info$'
}

if [ -z "$BASE_LABEL" ]; then
  if [ -n "$TARGET_TIME" ]; then
    # The newest base that finished AT OR BEFORE the target — never simply the
    # newest.
    #
    # Measured, and silent: with two bases in the repository, asking for an
    # instant before the second one was taken picked that second base, replayed
    # from a position already past the target, applied nothing, and returned a
    # database holding rows written after the moment that was asked for. It
    # printed `restore complete`. A restore that answers a question nobody
    # asked is worse than one that fails.
    BASE_LABEL="$(base_times \
      | awk -F';' -v t="$TARGET_TIME" '($1 "") <= (t "") {print}' \
      | sort | tail -1 | sed 's|.*;||; s|/binlog_info$||')"
    [ -n "$BASE_LABEL" ] || die "no base backup had finished by $TARGET_TIME. The oldest one in the repository is newer than the moment asked for, so there is nothing to replay onto — recovery cannot reach back before the first base."
  else
    BASE_LABEL="$(rclone lsf "$BASE_REMOTE/" 2>/dev/null | tr -d / | sort | tail -1)"
  fi
elif [ -n "$TARGET_TIME" ]; then
  # An explicitly named base has to satisfy the same rule.
  chosen_at="$(base_times | awk -F';' -v b="$BASE_LABEL/binlog_info" '$2 == b {print $1}')"
  if [ -n "$chosen_at" ] && [ "$chosen_at" \> "$TARGET_TIME" ]; then
    die "base backup $BASE_LABEL finished at $chosen_at, after the $TARGET_TIME asked for. Restoring it would hand back state from after that moment while reporting the moment."
  fi
fi
[ -n "$BASE_LABEL" ] || die "no base backup exists in $BASE_REMOTE. Binary logs alone cannot be restored — they are changes to something, and that something is the base."
log "base backup: $BASE_LABEL"

rclone copyto "$BASE_REMOTE/$BASE_LABEL/base.mbstream" "$WORK/base.mbstream" \
  || die "could not fetch the base backup"

mkdir -p "$DATADIR"
mbstream -x -C "$DATADIR" < "$WORK/base.mbstream" \
  || die "the base backup could not be extracted"

# The position the base ends at, read from inside the base itself.
#
# `mariadb-backup` writes `mariadb_backup_binlog_info` into every backup as
# `<file>\t<position>\t<gtid>`. Reading it here rather than from a sibling
# object in the repository means the position cannot disagree with the data it
# describes: they are the same artifact.
BINLOG_INFO="$DATADIR/mariadb_backup_binlog_info"
[ -s "$BINLOG_INFO" ] || die "the base backup records no binary log position, so there is no safe point to replay from"
START_FILE="$(awk -F'\t' 'NR==1{print $1}' "$BINLOG_INFO")"
START_POS="$(awk -F'\t' 'NR==1{print $2}' "$BINLOG_INFO")"
[ -n "$START_FILE" ] && [ -n "$START_POS" ] \
  || die "the base backup's recorded position could not be read: $(cat "$BINLOG_INFO")"
log "replaying from $START_FILE at $START_POS"

# An unprepared base does not boot at all — InnoDB aborts on a tablespace it
# cannot find. Preparing here rather than at backup time keeps incremental
# chains possible later.
mariadb-backup --prepare --target-dir="$DATADIR" \
  || die "the base backup could not be prepared, so it would not have started"

# `mbstream` extracts as whoever runs this, and the server refuses to start on
# files it cannot own. Doing it here means the restored volume is already the
# server's by the time it boots.
chown -R mysql:mysql "$DATADIR" 2>/dev/null || true

# ── the binary logs ─────────────────────────────────────────────────────────

REPLAY_FILES=""
if [ -n "$TARGET_TIME" ]; then
  AVAILABLE="$(rclone lsf "$LOG_REMOTE/" 2>/dev/null | grep -E '^binlog\.[0-9]+$' | sort)"
  [ -n "$AVAILABLE" ] || die "no binary logs are in the repository, so nothing can be replayed onto the base"

  mkdir -p "$WORK/logs"
  # The gap check, and the reason this script is not just a sequence of
  # commands. `mariadb-binlog` happily replays a non-contiguous set of files:
  # hand it 1, 2 and 4 and it will apply all three and exit zero, having
  # silently skipped everything in 3. The result is a database that starts,
  # answers queries, and is missing a stretch of history nobody will notice
  # until they look for it.
  FIRST_NUM="$(echo "$START_FILE" | sed 's/.*\.//' | sed 's/^0*//')"

  # The base's own log has to be there. Contiguity among whatever happens to
  # be present says nothing about the beginning: if the repository starts at
  # binlog.000003 and the base ends inside binlog.000002, the files that remain
  # are perfectly contiguous and `--start-position` — a byte offset into the
  # missing file — would be applied to a different one. That replays garbage
  # or nothing, and exits zero either way.
  echo "$AVAILABLE" | grep -qx "$START_FILE" \
    || die "the base backup ends inside $START_FILE, which is not in the repository. Replaying from the logs that are there would apply a position from one file to another; the base can only be restored on its own, without a target."

  PREV=""
  for f in $AVAILABLE; do
    num="$(echo "$f" | sed 's/.*\.//' | sed 's/^0*//')"
    [ "$num" -lt "$FIRST_NUM" ] && continue
    if [ -n "$PREV" ] && [ "$num" -ne "$((PREV + 1))" ]; then
      die "the binary logs jump from $PREV to $num. Restoring across that gap would produce a database missing every change in between, without any error to show for it."
    fi
    PREV="$num"
    rclone copyto "$LOG_REMOTE/$f" "$WORK/logs/$f" || die "could not fetch $f"
  done
  [ -n "$PREV" ] || die "the repository has no binary log at or after $START_FILE, so the base cannot be brought forward"
  REPLAY_FILES="$WORK/logs"
else
  log "no target given: restoring the base alone, without replaying any change"
fi

# ── bring it up out of reach, replay, and hand it its own credentials ───────

# Started with networking off and no external access: nothing may reach this
# database while it holds a partially replayed state. `--user=mysql` because
# the server refuses to run as root, and this container starts as root to be
# able to write the volume at all. `--skip-log-bin` because the init container
# does not mount the server's own config and must not begin a log here.
mariadbd --user=mysql --datadir="$DATADIR" \
  --skip-networking --skip-grant-tables --skip-log-bin \
  --socket="$WORK/restore.sock" >"$WORK/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 60); do
  mariadb --socket="$WORK/restore.sock" -e "SELECT 1" >/dev/null 2>&1 && break
  sleep 1
done
mariadb --socket="$WORK/restore.sock" -e "SELECT 1" >/dev/null 2>&1 \
  || { kill "$SERVER_PID" 2>/dev/null; die "the restored base did not start, so nothing was replayed onto it. $(tail -3 "$WORK/server.log" 2>/dev/null)"; }

if [ -n "$REPLAY_FILES" ]; then
  # `--stop-datetime` takes no timezone suffix and is read in the server's own
  # zone, so the container is pinned to UTC and the caller passes UTC.
  export TZ=UTC
  log "replaying up to $TARGET_TIME UTC"
  if ! mariadb-binlog --start-position="$START_POS" --stop-datetime="$TARGET_TIME" \
       "$REPLAY_FILES"/binlog.* \
       | mariadb --socket="$WORK/restore.sock"; then
    kill "$SERVER_PID" 2>/dev/null
    die "replaying the binary logs failed; the data directory is left incomplete on purpose rather than started as if it were whole"
  fi
fi

# The recovered accounts are the SOURCE's, so the passwords this install
# generated for itself do not open it and the credentials Flui shows would be
# wrong. This is the only credential-free moment there will ever be: the
# entrypoint never touches passwords on a populated data directory, and once
# this server shuts down nothing can authenticate to change them.
#
# After the replay, never before: a replayed log can carry the source's own
# `ALTER USER`, which would undo a reconcile done first.
#
# `FLUSH PRIVILEGES` first, because under `--skip-grant-tables` the server
# answers `ALTER USER` with error 1290. `UPDATE mysql.user` is not the way:
# in MariaDB it is a view over `global_priv` and answers "Column 'Password' is
# not updatable".
RECONCILE="FLUSH PRIVILEGES;"
if [ -n "${MARIADB_ROOT_PASSWORD:-}" ]; then
  RECONCILE="$RECONCILE
ALTER USER IF EXISTS 'root'@'localhost' IDENTIFIED BY '${MARIADB_ROOT_PASSWORD//\'/\'\'}';
ALTER USER IF EXISTS 'root'@'%' IDENTIFIED BY '${MARIADB_ROOT_PASSWORD//\'/\'\'}';"
fi
if [ -n "${MARIADB_USER:-}" ] && [ -n "${MARIADB_PASSWORD:-}" ]; then
  RECONCILE="$RECONCILE
ALTER USER IF EXISTS '${MARIADB_USER}'@'%' IDENTIFIED BY '${MARIADB_PASSWORD//\'/\'\'}';"
fi

# The base carries the healthcheck ACCOUNTS but not the credential file the
# probe reads — `mariadb-backup` copies database files, not the entrypoint's
# dotfile. Without it `healthcheck.sh --connect --innodb_initialized` answers
# `Access denied` and exits 1, the pod never turns Ready, and a restore that
# recovered the data perfectly is reported as failed. The entrypoint would
# create it, but it writes the file before the SQL that backs it, so a boot
# that fails in between leaves a cnf whose password was never applied and
# every later boot skips creation because the file is there.
HC_PASSWORD="$(head -c 24 /dev/urandom | base64 | tr -d '\n=+/' )"
RECONCILE="$RECONCILE
ALTER USER IF EXISTS 'healthcheck'@'localhost' IDENTIFIED BY '${HC_PASSWORD}';
ALTER USER IF EXISTS 'healthcheck'@'127.0.0.1' IDENTIFIED BY '${HC_PASSWORD}';
ALTER USER IF EXISTS 'healthcheck'@'::1' IDENTIFIED BY '${HC_PASSWORD}';"

if ! printf '%s\n' "$RECONCILE" | mariadb --socket="$WORK/restore.sock"; then
  kill "$SERVER_PID" 2>/dev/null
  die "the restored data could not be given this installation's own credentials, so the database would have come up answering only to the source's passwords"
fi

# SQL first, file last: a cnf that names a password the server never accepted
# is worse than no cnf, because the entrypoint will not rewrite one that exists.
cat > "$DATADIR/.my-healthcheck.cnf" <<CNF
[mariadb-client]
port=3306
socket=/run/mysqld/mysqld.sock
user=healthcheck
password=${HC_PASSWORD}
protocol=tcp
CNF
chmod 0600 "$DATADIR/.my-healthcheck.cnf"
chown mysql:mysql "$DATADIR/.my-healthcheck.cnf" 2>/dev/null || true

# The grant system is back on, so shutting down needs the credential just set.
mariadb --socket="$WORK/restore.sock" -uroot -p"${MARIADB_ROOT_PASSWORD:-}" \
  -e "SHUTDOWN" >/dev/null 2>&1
wait "$SERVER_PID" 2>/dev/null

touch "$DATADIR/.flui-restored"
chown mysql:mysql "$DATADIR/.flui-restored" 2>/dev/null || true
rm -rf "$WORK"
log "restore complete"
