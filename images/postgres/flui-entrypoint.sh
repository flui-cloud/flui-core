#!/usr/bin/env bash
# Flui Postgres entrypoint. Adds a restore-bootstrap mode, then hands off to the
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

[main]
pg1-path=${PGDATA}
EOF
  chown postgres:postgres "$RESTORE_CONF"
}

# Restore-bootstrap: populate PGDATA from a pgBackRest repo and recover to an
# optional point in time, then promote. Only when explicitly requested and
# PGDATA is not an initialized cluster. The marker is PG_VERSION, not
# emptiness: pgBackRest copies pg_control last, so an interrupted restore
# leaves a non-empty dir with no PG_VERSION — gating on emptiness would skip
# the retry forever, while --delta makes re-restoring into a dirty dir safe.
if [ "${FLUI_PG_RESTORE:-}" = "1" ] && [ ! -s "$PGDATA/PG_VERSION" ]; then
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
