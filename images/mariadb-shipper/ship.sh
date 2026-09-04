#!/bin/bash
#
# Ships a MariaDB's binary logs to object storage, continuously.
#
# Postgres hands each finished WAL segment to a command of Flui's choosing, so
# shipping is the database's own job. MariaDB writes its binary logs and forgets
# about them — nothing calls out — so something has to be alive and reading.
# That is this. It runs beside the database in the same pod, which is why
# kubelet restarts it, counts the restarts and keeps its logs.
#
# It never holds a credential Flui gave it: the MariaDB password comes from the
# pod's own environment, the same environment the database itself uses. Flui
# supplies object-storage credentials and nothing else.
#
# The rule the whole script is built around: **never purge a binary log that
# object storage has not confirmed.** A stalled shipper must fill a disk, which
# somebody notices, rather than quietly eat the recovery window, which nobody
# notices until a restore.

set -uo pipefail

: "${MARIADB_ROOT_PASSWORD:?the database password must come from the pod environment}"

HOST="${FLUI_DB_HOST:-127.0.0.1}"
PORT="${FLUI_DB_PORT:-3306}"
SPOOL="${FLUI_SPOOL_DIR:-/var/spool/flui-binlog}"
TICK="${FLUI_TICK_SECONDS:-60}"

# Where the destination arrives, and why it is a file rather than environment.
#
# This container is present on every MariaDB the catalog installs, whether or
# not anyone has asked for backups — that is what makes enabling one a change
# of configuration instead of a restart of the database. But a destination only
# exists once a policy does, and environment variables are fixed for the life
# of a pod: reading the destination from the environment would have put the
# restart back, in the one place the design exists to avoid it.
#
# A Secret mounted as a file updates in place, so creating the policy makes
# this appear and deleting it makes it vanish, both without touching the
# database. Until it appears this loop stays idle and says so.
CONFIG="${FLUI_CONFIG_FILE:-/etc/flui/shipper/config}"

mkdir -p "$SPOOL"
cd "$SPOOL" || exit 1

log() { printf '%s [shipper] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# Re-read every tick rather than once at start: a policy can be created,
# changed or deleted while this runs, and none of those should need a restart.
load_config() {
  [ -r "$CONFIG" ] || return 1
  # shellcheck disable=SC1090
  . "$CONFIG"
  [ -n "${FLUI_S3_REMOTE:-}" ] && [ -n "${FLUI_APP_ID:-}" ] || return 1
  REMOTE="${FLUI_S3_REMOTE}/binlog/${FLUI_APP_ID}"
  PURGE_FLOOR="${FLUI_PURGE_FLOOR:-}"
  return 0
}

mysql_cmd() {
  mariadb -h "$HOST" -P "$PORT" -uroot -p"$MARIADB_ROOT_PASSWORD" -N -B -e "$1" 2>/dev/null
}

# `--stop-never` follows the server like a replica and writes each log verbatim.
# It exits when the connection drops — a database restart, a network blip — so
# the supervisor loop below brings it back rather than assuming it stays up.
start_reader() {
  local first
  first="$(mysql_cmd 'SHOW BINARY LOGS' | head -1 | awk '{print $1}')"
  [ -z "$first" ] && return 1
  mariadb-binlog \
    --read-from-remote-server \
    --host="$HOST" --port="$PORT" \
    --user=root --password="$MARIADB_ROOT_PASSWORD" \
    --raw --stop-never \
    --result-file="$SPOOL/" \
    "$first" &
  READER_PID=$!
  log "reader started from $first (pid $READER_PID)"
}

# A closed log never changes again, so it is uploaded once and then only
# verified. The newest file is still being written, so it is re-uploaded every
# tick — bounded by `max_binlog_size`, which the Flui config pins to 64M.
upload() {
  local newest
  newest="$(ls -1 "$SPOOL" 2>/dev/null | grep -E '^binlog\.[0-9]+$' | sort | tail -1)"
  [ -z "$newest" ] && return 0

  for f in $(ls -1 "$SPOOL" | grep -E '^binlog\.[0-9]+$' | sort); do
    if [ "$f" = "$newest" ]; then
      # Active: overwrite each tick so the recoverable edge follows the server.
      rclone copyto "$SPOOL/$f" "$REMOTE/$f" --s3-no-check-bucket 2>&1 | sed 's/^/  rclone: /'
    elif ! rclone lsf "$REMOTE/$f" >/dev/null 2>&1; then
      rclone copyto "$SPOOL/$f" "$REMOTE/$f" --s3-no-check-bucket 2>&1 | sed 's/^/  rclone: /'
    fi
  done
}

# Confirmed means object storage listed it back, not that an upload command
# exited zero. The difference is the whole point of the purge rule below.
last_confirmed() {
  rclone lsf "$REMOTE/" 2>/dev/null \
    | grep -E '^binlog\.[0-9]+$' \
    | sort \
    | tail -1
}

# Purges only what is both confirmed in object storage and not needed by the
# oldest retained base backup. With no base declared, nothing is purged at all:
# binary logs with no base to replay onto are not a recovery window, and
# deleting them would trade a disk that fills for a window that lies.
purge_shipped() {
  local confirmed floor
  confirmed="$(last_confirmed)"
  [ -z "$confirmed" ] && return 0

  if [ -z "$PURGE_FLOOR" ]; then
    log "not purging: no base backup is declared, so shipped logs have nothing to be replayed onto"
    return 0
  fi

  floor="$PURGE_FLOOR"
  # Never past the base's own starting log, and never the active one: purge is
  # exclusive of its argument, so this keeps `confirmed` itself on the server.
  if [ "$floor" \< "$confirmed" ]; then
    mysql_cmd "PURGE BINARY LOGS TO '$floor'" >/dev/null
    log "purged server binary logs up to $floor (confirmed in object storage: $confirmed)"
  fi
}

# What an operator needs to see before a restore proves it, and what an alert
# would fire on: how far the shipped edge is behind the server's own.
report_lag() {
  local server_newest shipped_newest unshipped
  server_newest="$(mysql_cmd 'SHOW BINARY LOGS' | tail -1 | awk '{print $1}')"
  shipped_newest="$(last_confirmed)"
  unshipped="$(ls -1 "$SPOOL" 2>/dev/null | grep -cE '^binlog\.[0-9]+$')"
  log "server=$server_newest shipped=$shipped_newest spooled=$unshipped"
  if [ -n "$server_newest" ] && [ -n "$shipped_newest" ] && [ "$server_newest" != "$shipped_newest" ]; then
    log "WARNING: the shipped edge is behind the server — the recoverable window ends at $shipped_newest"
  fi
}

trap 'log "stopping"; kill "${READER_PID:-0}" 2>/dev/null; exit 0' TERM INT

log "started; idle until a backup policy provides a destination"
ANNOUNCED=""

while true; do
  if ! load_config; then
    # Not an error: most of these containers spend their whole life here,
    # because most databases are never given a backup policy.
    if [ -n "$ANNOUNCED" ]; then
      log "destination removed — shipping stopped, the database is untouched"
      kill "${READER_PID:-0}" 2>/dev/null
      READER_PID=""
      ANNOUNCED=""
    fi
    sleep "$TICK"
    continue
  fi

  if [ -z "$ANNOUNCED" ]; then
    log "shipping $FLUI_APP_ID to $REMOTE every ${TICK}s"
    ANNOUNCED=1
  fi

  if [ -z "${READER_PID:-}" ] || ! kill -0 "$READER_PID" 2>/dev/null; then
    # Not fatal and not silent: a database that is restarting, or not up yet,
    # is the normal reason to be here.
    if ! start_reader; then
      log "database not reachable yet; retrying in ${TICK}s"
      sleep "$TICK"
      continue
    fi
  fi

  # Closes the active log so it becomes immutable and uploadable. Without this
  # a quiet database's recoverable edge would sit behind the active file until
  # it reached its size limit — hours on a low-traffic server.
  mysql_cmd 'FLUSH BINARY LOGS' >/dev/null

  upload
  purge_shipped
  report_lag

  sleep "$TICK"
done
