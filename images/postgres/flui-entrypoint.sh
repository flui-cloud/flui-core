#!/usr/bin/env bash
# Flui Postgres entrypoint. Adds standby- and restore-bootstrap modes, then hands off to the
# stock postgres docker-entrypoint. Runs as root (image default); drops to the
# postgres user via gosu only for the restore work.
set -Eeo pipefail

PVC_ROOT="$(dirname "${PGDATA:?PGDATA must be set}")"
RESTORE_CONF="$PVC_ROOT/pgbackrest.restore.conf"

write_restore_conf() {
  umask 077
  cat > "$RESTORE_CONF" <<EOF
[global]
repo1-type=s3
repo1-storage-ca-file=/etc/ssl/certs/ca-certificates.crt
repo1-s3-endpoint=${FLUI_PG_S3_ENDPOINT}
repo1-s3-bucket=${FLUI_PG_S3_BUCKET}
repo1-s3-region=${FLUI_PG_S3_REGION}
repo1-s3-key=${FLUI_PG_S3_KEY}
repo1-s3-key-secret=${FLUI_PG_S3_KEY_SECRET}
repo1-s3-uri-style=${FLUI_PG_S3_URI_STYLE:-host}
repo1-path=${FLUI_PG_S3_PATH}
log-level-console=info
EOF
  # An encrypted repository needs its key; a plaintext one, written before
  # encryption, must be read without one.
  if [ -n "${FLUI_PG_CIPHER_PASS:-}" ]; then
    printf 'repo1-cipher-type=aes-256-cbc\nrepo1-cipher-pass=%s\n' "$FLUI_PG_CIPHER_PASS" >> "$RESTORE_CONF"
  fi
  printf '\n[main]\npg1-path=%s\n' "$PGDATA" >> "$RESTORE_CONF"
  chown postgres:postgres "$RESTORE_CONF"
}

# Standby-bootstrap: a live migration's destination. Waits for Flui to drop the
# source's connection and slot on the volume, copies the source with
# pg_basebackup and starts as its hot standby. The gate is the done marker, not
# PG_VERSION: pg_basebackup writes PG_VERSION early, so an interrupted copy
# must be wiped and retried, never started.
STANDBY_DIR="$PVC_ROOT/flui-standby"
if [ "${FLUI_PG_STANDBY:-}" = "1" ] && [ ! -f "$STANDBY_DIR/done" ]; then
  # Waits run in the background so a stop request ends them at once.
  trap 'exit 0' TERM INT
  mkdir -p "$STANDBY_DIR" && chown postgres:postgres "$STANDBY_DIR" && chmod 700 "$STANDBY_DIR"
  echo "[flui-entrypoint] standby-bootstrap: waiting for the primary's connection"
  until [ -s "$STANDBY_DIR/conninfo" ] && [ -s "$STANDBY_DIR/slot" ]; do
    if [ -f "$STANDBY_DIR/aborted" ]; then
      echo "[flui-entrypoint] migration aborted; not starting"
      sleep infinity & wait $!
    fi
    sleep 5 & wait $!
  done
  until [ -f "$STANDBY_DIR/aborted" ]; do
    if [ -s "$STANDBY_DIR/conninfo" ]; then
      mkdir -p "$PGDATA" && chown postgres:postgres "$PGDATA" && chmod 0700 "$PGDATA"
      find "$PGDATA" -mindepth 1 -delete
      echo "[flui-entrypoint] standby-bootstrap: copying the primary"
      gosu postgres pg_basebackup -D "$PGDATA" -d "$(cat "$STANDBY_DIR/conninfo")" \
        -S "$(cat "$STANDBY_DIR/slot")" -X stream -R -c fast -v &
      if wait $!; then
        break
      fi
      echo "[flui-entrypoint] base backup failed; retrying in 15s"
    fi
    sleep 15 & wait $!
  done
  if [ -f "$STANDBY_DIR/aborted" ]; then
    echo "[flui-entrypoint] migration aborted; not starting"
    while :; do sleep infinity & wait $!; done
  fi
  # The copy carries the primary's postgresql.auto.conf: its archive_command
  # names a config file that is not on this volume, and its ssl names a
  # certificate that is not either. Neutralised here, reset after promote.
  printf "archive_command = '/bin/true'\nssl = off\n" >> "$PGDATA/postgresql.auto.conf"
  chown postgres:postgres "$PGDATA/postgresql.auto.conf"
  rm -f "$STANDBY_DIR/conninfo"
  touch "$STANDBY_DIR/done"
  echo "[flui-entrypoint] standby-bootstrap: copy complete; starting as a hot standby"
  trap - TERM INT
fi

# Restore-bootstrap: populate PGDATA from a pgBackRest repo and recover to an
# optional point in time, then promote. Only when explicitly requested and
# PGDATA is not an initialized cluster. The marker is PG_VERSION, not
# emptiness: pgBackRest copies pg_control last, so an interrupted restore
# leaves a non-empty dir with no PG_VERSION — gating on emptiness would skip
# the retry forever, while --delta makes re-restoring into a dirty dir safe.
if [ "${FLUI_PG_RESTORE:-}" = "1" ] && [ "${FLUI_PG_STANDBY:-}" != "1" ] && [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "[flui-entrypoint] restore-bootstrap: recovering PGDATA from pgBackRest repo"
  mkdir -p "$PGDATA"
  chown postgres:postgres "$PGDATA"
  chmod 0700 "$PGDATA"
  write_restore_conf
  # Three shapes: explicit time target (PITR), a specific backup set restored
  # to its own consistency point (--type=immediate — a time target equal to the
  # backup's stop is rejected by pgBackRest, which wants stop < target), or
  # latest (no target: postgres promotes on its own at end-of-WAL).
  if [ -n "${FLUI_PG_RESTORE_TARGET:-}" ]; then
    gosu postgres pgbackrest --config="$RESTORE_CONF" --stanza=main --delta \
      --type=time "--target=${FLUI_PG_RESTORE_TARGET}" --target-action=promote restore
  elif [ -n "${FLUI_PG_RESTORE_SET:-}" ]; then
    gosu postgres pgbackrest --config="$RESTORE_CONF" --stanza=main --delta \
      --set="${FLUI_PG_RESTORE_SET}" --type=immediate --target-action=promote restore
  else
    gosu postgres pgbackrest --config="$RESTORE_CONF" --stanza=main --delta restore
  fi
  # The restored postgresql.auto.conf carries the source's archive_command,
  # whose config file lives outside PGDATA and was not restored — neutralize it
  # or WAL recycling stalls. Enabling backup on this install rewrites it.
  echo "archive_command = '/bin/true'" >> "$PGDATA/postgresql.auto.conf"
  chown postgres:postgres "$PGDATA/postgresql.auto.conf"
  echo "[flui-entrypoint] restore complete; starting postgres to recover + promote"

  # The restored roles carry the SOURCE database's password. Reconcile the app's
  # own superuser to THIS install's generated POSTGRES_PASSWORD so the clone is
  # usable with its Flui-managed credentials. Runs in the background once postgres
  # is up and promoted (local socket = trust; the role already exists in the
  # restored data because the install passes the source's POSTGRES_USER).
  if [ -n "${POSTGRES_PASSWORD:-}" ] && [ -n "${POSTGRES_USER:-}" ]; then
    (
      for _ in $(seq 1 180); do
        if [ "$(gosu postgres psql -U "$POSTGRES_USER" -d postgres -tAc 'SELECT NOT pg_is_in_recovery()' 2>/dev/null)" = "t" ]; then
          break
        fi
        sleep 1
      done
      # psql interpolates :'pw' (safely quoted) only from stdin/-f, NOT from -c.
      printf '%s\n' "ALTER ROLE \"$POSTGRES_USER\" WITH PASSWORD :'pw';" \
        | gosu postgres psql -U "$POSTGRES_USER" -d postgres \
            -v ON_ERROR_STOP=1 -v pw="$POSTGRES_PASSWORD" \
        && echo "[flui-entrypoint] reconciled superuser password to this install" \
        || echo "[flui-entrypoint] WARN: password reconcile failed (connect with the source's credentials)"
    ) &
  fi
fi

exec docker-entrypoint.sh "$@"
