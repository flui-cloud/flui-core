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

# This container must never exit on its own.
#
# It is an ordinary container in the database's pod, so kubelet counts its
# exits and a CrashLoopBackOff makes the whole pod not-Ready — which takes the
# database out of its Service and off the network for everything that connects
# to it. A backup companion that can take the database down has inverted its
# own purpose, so every condition it cannot work under is an idle state that
# says so, not an exit.
DBPW="${MARIADB_ROOT_PASSWORD:-}"

# Re-read every tick rather than once at start: a policy can be created,
# changed or deleted while this runs, and none of those should need a restart.
load_config() {
  [ -r "$CONFIG" ] || return 1
  # Clear first: sourcing does not unset a key that has disappeared, so a
  # value removed from the Secret would otherwise keep its last reading
  # forever — including the destination this ships to.
  unset FLUI_S3_REMOTE FLUI_APP_ID FLUI_CONFIG_COMPLETE
  unset RCLONE_CONFIG_FLUI_TYPE RCLONE_CONFIG_FLUI_PROVIDER \
        RCLONE_CONFIG_FLUI_ACCESS_KEY_ID RCLONE_CONFIG_FLUI_SECRET_ACCESS_KEY \
        RCLONE_CONFIG_FLUI_ENDPOINT RCLONE_CONFIG_FLUI_REGION \
        RCLONE_CONFIG_FLUI_FORCE_PATH_STYLE
  # shellcheck disable=SC1090
  . "$CONFIG" 2>/dev/null || return 1
  # The sentinel is the last line the writer emits, so a file that is present
  # but incomplete is refused instead of half-applied. kubelet swaps the whole
  # directory atomically, so this should never fire — which is exactly why it
  # is cheap to keep and expensive to have assumed.
  [ "${FLUI_CONFIG_COMPLETE:-}" = "1" ] || return 1
  [ -n "${FLUI_S3_REMOTE:-}" ] && [ -n "${FLUI_APP_ID:-}" ] || return 1
  REMOTE="${FLUI_S3_REMOTE}/binlog"
  BASE_REMOTE="${FLUI_S3_REMOTE}/base"
  return 0
}

# Every call to object storage, with a deadline.
#
# rclone's defaults retry for minutes, and each tick makes several calls: an
# unreachable endpoint stopped the loop dead — no upload, no purge, and no
# `report_lag` line either, so the one symptom of an outage was that the
# shipper went quiet. A backup companion that says nothing while it is failing
# is the thing this design exists to avoid, so the calls fail fast and the loop
# keeps ticking and keeps saying what it cannot do.
rc() {
  rclone --contimeout 10s --timeout 30s --retries 1 --low-level-retries 2 "$@"
}

mysql_cmd() {
  mariadb -h "$HOST" -P "$PORT" -uroot -p"$DBPW" -N -B -e "$1" 2>/dev/null
}

# The oldest log any retained base still needs, read from the repository.
#
# From the repository and not from the config, because only the repository
# knows which bases survived — the same rule the recoverable window follows.
# A base records the log it ends at inside itself and, so this can be answered
# without pulling a multi-gigabyte stream, in a sibling `binlog_info` written
# in the same format.
base_start_file() {
  rc cat "$BASE_REMOTE/$1/binlog_info" 2>/dev/null \
    | awk -F'\t' 'NR==1{print $1}'
}

# Is every log from $1 to $2 in the repository?
#
# The gate on advancing the floor. Moving it means the server stops holding the
# logs below it, so from that moment the repository is the only place they
# exist — and if it has a hole there, the older bases it still holds can no
# longer be brought forward. The restore refuses on such a hole, which is the
# right end of the story; this keeps it from being written in the first place.
repo_contiguous() {
  local from to n want have
  from="$(echo "$1" | sed 's/.*\.//' | sed 's/^0*//')"
  to="$(echo "$2" | sed 's/.*\.//' | sed 's/^0*//')"
  have="$(rc lsf "$REMOTE/" 2>/dev/null | grep -E '^binlog\.[0-9]+$' | sed 's/.*\.//' | sed 's/^0*//')"
  n="$from"
  while [ "$n" -lt "$to" ]; do
    want="$n"
    printf '%s\n' "$have" | grep -qx "$want" || return 1
    n=$((n + 1))
  done
  return 0
}

# The oldest log the server still has to keep.
#
# The NEWEST base's starting log, not the oldest. Reading the oldest meant the
# floor was the first base ever taken and never moved again — and with
# `binlog_expire_logs_seconds = 0` the server would retain every log since that
# first base for the life of the policy, which is the disk-fill this whole
# design exists to avoid, arriving slowly instead of at once. Everything below
# the new floor stays recoverable from the repository, which is why advancing
# is gated on the repository actually holding it.
# The starting log of the OLDEST base the repository still holds.
#
# "Holds" means it has a position file: a base whose stream has landed but
# whose `binlog_info` has not is invisible to every reader, including the
# restore, and must be invisible here too — otherwise a floor would be derived
# from a base nothing can use.
oldest_base_start() {
  local b f
  for b in $(rc lsf "$BASE_REMOTE/" 2>/dev/null | tr -d / | sort); do
    f="$(base_start_file "$b")"
    [ -n "$f" ] && { echo "$f"; return 0; }
  done
}

newest_base_start() {
  local b f last=""
  for b in $(rc lsf "$BASE_REMOTE/" 2>/dev/null | tr -d / | sort); do
    f="$(base_start_file "$b")"
    [ -n "$f" ] && last="$f"
  done
  echo "$last"
}

# What the SERVER still has to keep: the newest base's starting log when the
# repository provably holds everything between the two, otherwise the oldest's.
purge_floor() {
  local oldest newest
  oldest="$(oldest_base_start)"
  [ -z "$oldest" ] && return 0
  newest="$(newest_base_start)"
  if [ -n "$newest" ] && [ "$newest" != "$oldest" ] \
     && repo_contiguous "$oldest" "$newest"; then
    echo "$newest"
    return 0
  fi
  echo "$oldest"
}

# What the REPOSITORY no longer needs: everything below the oldest surviving
# base's starting log.
#
# A different floor from the server's, and necessarily lower. The server may
# forget everything up to the newest base because the repository still has the
# rest; the repository may only forget what no surviving base could ever be
# replayed forward from — and nothing surviving begins earlier than its oldest.
#
# Takes the floor as an argument rather than recomputing it, so that a base
# deleted by retention between one call and the next cannot make this prune
# reach above the floor the server was purged to in the same tick.
prune_repository() {
  local floor="$1" f
  [ -z "$floor" ] && return 0
  for f in $(rc lsf "$REMOTE/" 2>/dev/null | grep -E '^binlog\.[0-9]+$' | sort); do
    [ "$f" \< "$floor" ] || break
    rc deletefile "$REMOTE/$f" >/dev/null 2>&1 \
      && log "removed $f from the repository: no surviving base backup starts that early"
  done
}

# `--stop-never` follows the server like a replica and writes each log verbatim.
# It exits when the connection drops — a database restart, a network blip — so
# the supervisor loop below brings it back rather than assuming it stays up.
start_reader() {
  local first floor
  first="$(mysql_cmd 'SHOW BINARY LOGS' | head -1 | awk '{print $1}')"
  [ -z "$first" ] && return 1

  # Start at the oldest log any retained base still needs, never below it.
  #
  # Measured, and the reason this is not an optimisation: starting at the
  # server's oldest log meant the first purge — which deletes everything below
  # that same floor — removed the file the reader was streaming at that
  # instant. The dump thread died on it and the reader carried on from the next
  # rotation, silently skipping `binlog.000002`: the one file the base's
  # recorded position points into, and therefore the only one whose absence
  # makes the base unrecoverable. Beginning at the floor makes the reader and
  # the purge agree by construction instead of by timing.
  floor="$(purge_floor)"
  if [ -n "$floor" ]; then
    if [ "$first" \< "$floor" ]; then
      first="$floor"
    elif [ "$floor" \< "$first" ]; then
      # The log a retained base needs is no longer on the server — someone
      # purged by hand, or the server's own expiry ran while no policy was
      # active. Nothing can close that hole from here, and saying so is the
      # only useful thing to do: the restore's own check is the last guard.
      log "WARNING: a base backup starts at $floor but the server's oldest log is $first — the window between them exists only in object storage, and a base older than $first can no longer be brought forward from this server"
    fi
  fi
  mariadb-binlog \
    --read-from-remote-server \
    --host="$HOST" --port="$PORT" \
    --user=root --password="$DBPW" \
    --raw --stop-never \
    --result-file="$SPOOL/" \
    "$first" &
  READER_PID=$!
  # Backgrounding always succeeds, so without this a reader that dies on its
  # first command — a starting log the server does not have — is reported as
  # started on every tick while nothing is ever shipped, and the only symptom
  # is `report_lag` describing the edge as merely behind.
  sleep 1
  if ! kill -0 "$READER_PID" 2>/dev/null; then
    READER_PID=""
    log "reader could not follow the server from $first; retrying next tick"
    return 1
  fi
  log "reader started from $first (pid $READER_PID)"
}

# One listing per tick: what the repository holds, and how big.
remote_sizes() {
  rc lsl "$REMOTE/" 2>/dev/null | awk '{print $NF"\t"$1}'
}

# Ships anything whose local copy differs in size from the repository's.
#
# Size, not presence, and this is the difference between a recovery window and
# the appearance of one. A log is uploaded while it is still the file the
# server is writing, so what lands is a prefix; when it rotates, the reader
# appends the rest locally and the file is complete — but a presence test calls
# it already shipped and the tail never goes up. Measured: every file in the
# repository stopped at 379 bytes while the server's held 423 and 649, and a
# restore that replayed them lost a committed row and reported success.
upload() {
  local sizes f local_size remote_size
  sizes="$(remote_sizes)"
  for f in $(ls -1 "$SPOOL" 2>/dev/null | grep -E '^binlog\.[0-9]+$' | sort); do
    local_size="$(stat -c%s "$SPOOL/$f" 2>/dev/null || echo 0)"
    remote_size="$(printf '%s\n' "$sizes" | awk -F'\t' -v n="$f" '$1==n{print $2}')"
    # Absent, or the local copy has grown past it. NEVER when the local copy
    # is shorter: the spool is the container's writable layer and is empty
    # after a restart, so the reader re-downloads from the floor and a
    # half-fetched log would otherwise be written over the complete object
    # already in the repository. `mariadb-binlog` replays a truncated file
    # without complaining, so a restore inside that window is silently wrong.
    if [ -n "$remote_size" ] && [ "$local_size" -le "$remote_size" ]; then
      continue
    fi
    # `--local-no-check-updated` because the newest log is being appended to
    # while it is read: without it the end-of-transfer size check can call the
    # transfer corrupt, delete the object and retry for as long as writes
    # continue. With it the object is an exact prefix, which is what the next
    # tick extends.
    rc copyto "$SPOOL/$f" "$REMOTE/$f" --s3-no-check-bucket \
      --local-no-check-updated 2>&1 | sed 's/^/  rclone: /'
  done
}

# Confirmed means object storage listed it back, not that an upload command
# exited zero. The difference is the whole point of the purge rule below.
last_confirmed() {
  rc lsf "$REMOTE/" 2>/dev/null \
    | grep -E '^binlog\.[0-9]+$' \
    | sort \
    | tail -1
}

# Purges only what is both confirmed in object storage and not needed by the
# oldest retained base backup. With no base at all, nothing is purged: binary
# logs with no base to replay onto are not a recovery window, and deleting them
# would trade a disk that fills for a window that lies.
purge_shipped() {
  local confirmed floor
  confirmed="$(last_confirmed)"
  [ -z "$confirmed" ] && return 0

  floor="$(purge_floor)"
  if [ -z "$floor" ]; then
    log "not purging: no base backup is in the repository, so shipped logs have nothing to be replayed onto"
    return 0
  fi
  # Never past the base's own starting log, and never the active one: purge is
  # exclusive of its argument, so this keeps `confirmed` itself on the server.
  if [ "$floor" \< "$confirmed" ]; then
    mysql_cmd "PURGE BINARY LOGS TO '$floor'" >/dev/null
    log "purged server binary logs up to $floor (confirmed in object storage: $confirmed)"
  fi
}

# The spool is the container's own writable layer, and `--raw --stop-never`
# mirrors every log the server has ever had into it. Without this it grows
# until the node evicts the pod for disk pressure — which restarts the
# database, the outcome this companion exists never to cause.
#
# A file goes only once the repository holds it at the SAME size.
#
# The spool is the container's own writable layer, and `--raw --stop-never`
# mirrors every log the server has ever had into it. Without pruning it grows
# until the node evicts the pod for disk pressure — which restarts the
# database, the outcome this companion exists never to cause. Matching on size
# rather than presence is what keeps pruning from deleting the local copy of a
# log whose tail has not been shipped yet.
prune_spool() {
  local sizes newest f local_size remote_size
  newest="$(ls -1 "$SPOOL" 2>/dev/null | grep -E '^binlog\.[0-9]+$' | sort | tail -1)"
  [ -z "$newest" ] && return 0
  sizes="$(remote_sizes)"
  for f in $(ls -1 "$SPOOL" 2>/dev/null | grep -E '^binlog\.[0-9]+$' | sort); do
    # The newest is still being appended to; kept until something newer exists.
    [ "$f" = "$newest" ] && continue
    local_size="$(stat -c%s "$SPOOL/$f" 2>/dev/null || echo 0)"
    remote_size="$(printf '%s\n' "$sizes" | awk -F'\t' -v n="$f" '$1==n{print $2}')"
    [ -n "$remote_size" ] && [ "$local_size" = "$remote_size" ] && rm -f "$SPOOL/$f"
  done
}

# What an operator needs to see before a restore proves it, and what an alert
# would fire on: how far the shipped edge is behind the server's own.
report_lag() {
  local server_newest shipped_newest unshipped
  server_newest="$(mysql_cmd 'SHOW BINARY LOGS' | tail -1 | awk '{print $1}')"
  shipped_newest="$(last_confirmed)"
  unshipped="$(ls -1 "$SPOOL" 2>/dev/null | grep -cE '^binlog\.[0-9]+$')"
  # The name alone says nothing about completeness: a repository object that
  # stopped at a prefix of its log carries the same name as the whole file.
  local edge_local edge_remote
  edge_local="$(stat -c%s "$SPOOL/$shipped_newest" 2>/dev/null || echo '')"
  edge_remote="$(rc lsl "$REMOTE/$shipped_newest" 2>/dev/null | awk '{print $1}')"
  log "server=$server_newest shipped=$shipped_newest (${edge_remote:-?} bytes) spooled=$unshipped"
  if [ -n "$server_newest" ] && [ -z "$shipped_newest" ]; then
    log "WARNING: nothing has reached object storage — every binary log since the last confirmed one exists only on this cluster, and the server is holding them all"
  # Only a CLOSED log is expected to be whole. The active one is a prefix by
  # definition — it is re-uploaded each tick as the server appends to it — so
  # warning about it would fire on almost every tick of a busy database, and a
  # warning that is always on is one nobody reads when it finally means
  # something.
  elif [ "$server_newest" != "$shipped_newest" ] \
       && [ -n "$edge_local" ] && [ -n "$edge_remote" ] \
       && [ "$edge_local" != "$edge_remote" ]; then
    log "WARNING: $shipped_newest is $edge_remote bytes in object storage against $edge_local locally — the shipped copy is a prefix and a restore through it would stop early"
  fi
  if [ -n "$server_newest" ] && [ -n "$shipped_newest" ] && [ "$server_newest" != "$shipped_newest" ]; then
    log "WARNING: the shipped edge is behind the server — the recoverable window ends at $shipped_newest"
  fi
}

trap 'log "stopping"; kill "${READER_PID:-0}" 2>/dev/null; exit 0' TERM INT

log "started; idle until a backup policy provides a destination"
ANNOUNCED=""

while true; do
  # Idle rather than exit, for the reason above: kubelet would read an exit as
  # a crash and take the database's pod out of its Service.
  if [ -z "$DBPW" ]; then
    log "no database password in this pod's environment; nothing can be shipped"
    sleep "$TICK"
    continue
  fi

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

  # One reading of the floor for the whole tick: the server purge and the
  # repository prune must not disagree about which bases exist.
  OLDEST_START="$(oldest_base_start)"

  upload
  purge_shipped
  prune_repository "$OLDEST_START"
  prune_spool
  report_lag

  sleep "$TICK"
done
