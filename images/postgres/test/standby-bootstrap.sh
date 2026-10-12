#!/usr/bin/env bash
# Local check of the standby-bootstrap mode: a primary and a standby container
# on one network, the standby bootstrapped from files dropped on its volume,
# an interrupted first copy retried, streaming over TLS, the pg_hba fence
# holding while replication flows, pg_promote, and an abort before the copy.
# Usage: images/postgres/test/standby-bootstrap.sh   (ENGINE=docker to use Docker,
# PLATFORM=linux/arm64 when the local base image is of another architecture)
set -Eeuo pipefail

ENGINE="${ENGINE:-podman}"
IMAGE="${IMAGE:-flui-postgres:standby-test}"
NET=flui-standby-test
P=flui-standby-primary
S=flui-standby-standby
A=flui-standby-aborted
PGDATA=/var/lib/postgresql/data/pgdata
PVC=/var/lib/postgresql/data
SLOT=flui_phys_test
ROLE=flui_repl_test
APP=flui_mig_test
PW=replpw

cleanup() {
  $ENGINE rm -f $P $S $A >/dev/null 2>&1 || true
  $ENGINE network rm $NET >/dev/null 2>&1 || true
}
fail() {
  echo "FAIL: $*" >&2
  $ENGINE logs --tail 30 $S >&2 2>&1 || true
  exit 1
}
pass() { echo "ok - $*"; }
sql() {
  local c=$1
  shift
  $ENGINE exec -i "$c" gosu postgres psql -U app -d app -tA -v ON_ERROR_STOP=1 "$@"
}
wait_for() {
  local what=$1 tries=$2
  shift 2
  for _ in $(seq 1 "$tries"); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  fail "timed out waiting for: $what"
}
conninfo() {
  printf 'host=%s port=5432 user=%s password=%s application_name=%s sslmode=verify-ca sslrootcert=%s\n' \
    "$P" "$ROLE" "$1" "$APP" "$PVC/flui-repl-ca-test.crt"
}
drop_conninfo() {
  conninfo "$2" | $ENGINE exec -i "$1" sh -c \
    "umask 077 && cat > $PVC/flui-standby/conninfo.tmp && chown postgres:postgres $PVC/flui-standby/conninfo.tmp && mv $PVC/flui-standby/conninfo.tmp $PVC/flui-standby/conninfo"
}

trap cleanup EXIT
[ "${SKIP_BUILD:-}" = 1 ] || $ENGINE build -q ${PLATFORM:+--platform "$PLATFORM"} -t "$IMAGE" "$(cd "$(dirname "$0")/.." && pwd)" >/dev/null
cleanup
$ENGINE network create $NET >/dev/null
SUBNET=$($ENGINE network inspect $NET --format '{{range .Subnets}}{{.Subnet}}{{end}}')

$ENGINE run -d --name $P --network $NET -e POSTGRES_USER=app -e POSTGRES_PASSWORD=apppw \
  -e POSTGRES_DB=app -e PGDATA=$PGDATA "$IMAGE" >/dev/null
wait_for "primary ready" 60 $ENGINE exec $P pg_isready -U app -h 127.0.0.1
sleep 2
wait_for "primary ready after init" 30 $ENGINE exec $P pg_isready -U app -h 127.0.0.1

# Source preparation as Flui does it: TLS, per-link role, slot, replication block.
$ENGINE exec $P sh -c "cd $PVC && openssl req -x509 -newkey rsa:2048 -keyout flui-repl-server.key -out flui-repl-server.crt -days 1 -nodes -subj /CN=primary >/dev/null 2>&1 && chown postgres:postgres flui-repl-server.key flui-repl-server.crt && chmod 600 flui-repl-server.key"
sql $P >/dev/null <<SQL
ALTER SYSTEM SET ssl = on;
ALTER SYSTEM SET ssl_cert_file = '$PVC/flui-repl-server.crt';
ALTER SYSTEM SET ssl_key_file = '$PVC/flui-repl-server.key';
ALTER SYSTEM SET max_slot_wal_keep_size = '256MB';
SELECT pg_reload_conf();
CREATE ROLE $ROLE WITH REPLICATION LOGIN PASSWORD '$PW';
SELECT pg_create_physical_replication_slot('$SLOT', true);
CREATE TABLE t (id int PRIMARY KEY, v text);
INSERT INTO t SELECT g, 'before' FROM generate_series(1, 1000) g;
SQL
$ENGINE exec $P sh -c "{ printf '# flui:repl:test:begin\nhostssl   replication $ROLE $SUBNET scram-sha-256\nhostnossl replication all 0.0.0.0/0 reject\n# flui:repl:test:end\n'; cat \$PGDATA/pg_hba.conf; } > /tmp/hba && cat /tmp/hba > \$PGDATA/pg_hba.conf"
[ "$(sql $P -c 'SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL')" = 0 ] || fail "primary pg_hba.conf does not parse"
sql $P -c 'SELECT pg_reload_conf()' >/dev/null
[ "$(sql $P -c 'SHOW ssl')" = on ] || fail "primary TLS not on"

# The standby waits for its files and initialises nothing meanwhile.
$ENGINE run -d --name $S --network $NET -e POSTGRES_USER=app -e POSTGRES_PASSWORD=generated \
  -e POSTGRES_DB=app -e PGDATA=$PGDATA -e FLUI_PG_STANDBY=1 "$IMAGE" >/dev/null
sleep 8
$ENGINE exec $S test ! -e $PGDATA/PG_VERSION || fail "standby initialised before its files arrived"
$ENGINE logs $S 2>&1 | grep -q "waiting for the primary's connection" || fail "standby is not waiting"
pass "standby waits for its connection files"

$ENGINE exec $P cat $PVC/flui-repl-server.crt | $ENGINE exec -i $S sh -c \
  "cat > $PVC/flui-repl-ca-test.crt && chown postgres:postgres $PVC/flui-repl-ca-test.crt && chmod 0644 $PVC/flui-repl-ca-test.crt"
printf '%s' $SLOT | $ENGINE exec -i $S sh -c "cat > $PVC/flui-standby/slot && chown postgres:postgres $PVC/flui-standby/slot"
drop_conninfo $S wrong-password
wait_for "a failed first copy" 30 sh -c "$ENGINE logs $S 2>&1 | grep -q 'base backup failed'"
pass "a failed copy is retried, not started"
drop_conninfo $S $PW
wait_for "standby up" 120 sh -c "$ENGINE exec $S test -f $PVC/flui-standby/done && $ENGINE exec $S pg_isready -U app -h 127.0.0.1"
wait_for "hot standby accepting reads" 30 sh -c "[ \"\$($ENGINE exec $S gosu postgres psql -U app -d app -tAc 'SELECT pg_is_in_recovery()')\" = t ]"
pass "standby copied the primary and runs as a hot standby"

$ENGINE exec $S test ! -e $PVC/flui-standby/conninfo || fail "the connection file with the password was left behind"
[ "$(sql $S -c 'SHOW ssl')" = off ] || fail "standby kept the primary's ssl"
[ "$(sql $S -c 'SHOW archive_command')" = /bin/true ] || fail "standby kept the primary's archive_command"
[ "$(sql $S -c 'SELECT count(*) FROM t')" = 1000 ] || fail "standby does not have the copied rows"
pass "copied ssl and archive_command neutralised, password file removed"

wait_for "streaming" 30 sh -c "[ \"\$($ENGINE exec $P gosu postgres psql -U app -d app -tAc \"SELECT state FROM pg_stat_replication WHERE application_name='$APP'\")\" = streaming ]"
[ "$(sql $P -c "SELECT s.ssl FROM pg_stat_replication r JOIN pg_stat_ssl s USING (pid) WHERE r.application_name='$APP'")" = t ] || fail "replication is not over TLS"
[ "$(sql $P -c "SELECT active FROM pg_replication_slots WHERE slot_name='$SLOT'")" = t ] || fail "standby does not use the slot"
pass "streaming over TLS through the per-link slot"

if sql $S -c "INSERT INTO t VALUES (0, 'x')" >/dev/null 2>&1; then fail "the standby accepted a write"; fi
pass "standby refuses writes"

$ENGINE restart $S >/dev/null
wait_for "standby back after restart" 60 sh -c "[ \"\$($ENGINE exec $S gosu postgres psql -U app -d app -tAc 'SELECT pg_is_in_recovery()')\" = t ]"
[ "$($ENGINE logs $S 2>&1 | grep -c 'copying the primary')" -le 2 ] || fail "a restart copied the primary again"
pass "a restart after the copy does not copy again"

# Abort on a running standby: it stops dialling the primary on a reload.
sql $S -c 'ALTER SYSTEM RESET primary_conninfo' >/dev/null
sql $S -c 'SELECT pg_reload_conf()' >/dev/null
wait_for "standby stops dialling" 30 sh -c "[ \"\$($ENGINE exec $S gosu postgres psql -U app -d app -tAc 'SELECT count(*) FROM pg_stat_wal_receiver')\" = 0 ]"
[ "$(sql $S -c 'SELECT pg_is_in_recovery()')" = t ] || fail "a standby left recovery when told to stop dialling"
sql $S -c "ALTER SYSTEM SET primary_conninfo = '$(conninfo $PW | tr -d '\n')'" >/dev/null
sql $S -c 'SELECT pg_reload_conf()' >/dev/null
wait_for "streaming again" 30 sh -c "[ \"\$($ENGINE exec $P gosu postgres psql -U app -d app -tAc \"SELECT state FROM pg_stat_replication WHERE application_name='$APP'\")\" = streaming ]"
pass "a standby stops dialling on reset + reload, and stays in recovery"

# The fence: TCP clients rejected and terminated, the local socket and replication untouched.
$ENGINE exec $P sh -c "{ printf '# flui:fence:test:begin\nhost all all 0.0.0.0/0 reject\nhost all all ::/0 reject\n# flui:fence:test:end\n'; cat \$PGDATA/pg_hba.conf; } > /tmp/hba && cat /tmp/hba > \$PGDATA/pg_hba.conf"
sql $P -c 'SELECT pg_reload_conf()' >/dev/null
sql $P -c "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE backend_type = 'client backend' AND client_addr IS NOT NULL AND pid <> pg_backend_pid()" >/dev/null
if $ENGINE exec $S psql "host=$P user=app password=apppw dbname=app sslmode=disable" -tAc 'SELECT 1' >/dev/null 2>&1; then
  fail "a TCP client got through the fence"
fi
if $ENGINE exec $S psql "host=$P user=app password=apppw dbname=app sslmode=require" -tAc 'SELECT 1' >/dev/null 2>&1; then
  fail "a TLS client got through the fence"
fi
sql $P -c "INSERT INTO t SELECT g, 'after-fence' FROM generate_series(1001, 2000) g" >/dev/null
LSN=$(sql $P -c 'SELECT pg_current_wal_lsn()')
wait_for "replay past the fence LSN" 30 sh -c "[ \"\$($ENGINE exec $S gosu postgres psql -U app -d app -tAc \"SELECT pg_last_wal_replay_lsn() >= '$LSN'::pg_lsn\")\" = t ]"
[ "$(sql $S -c 'SELECT count(*) FROM t')" = 2000 ] || fail "writes made under the fence did not reach the standby"
pass "fence rejects TCP clients while replication reaches the fence LSN"

[ "$(sql $S -c 'SELECT pg_promote(true, 60)')" = t ] || fail "pg_promote did not confirm"
[ "$(sql $S -c 'SELECT pg_is_in_recovery()')" = f ] || fail "promoted copy still in recovery"
sql $S >/dev/null <<SQL
ALTER SYSTEM RESET primary_conninfo;
ALTER SYSTEM RESET primary_slot_name;
ALTER SYSTEM RESET ssl;
ALTER SYSTEM RESET archive_command;
ALTER SYSTEM RESET max_slot_wal_keep_size;
SELECT pg_reload_conf();
DROP ROLE IF EXISTS $ROLE;
INSERT INTO t VALUES (2001, 'promoted');
SQL
$ENGINE exec $S sh -c "sed -i -e '/^# flui:repl:[0-9a-z]*:begin\$/,/^# flui:repl:[0-9a-z]*:end\$/d' -e '/^# flui:fence:[0-9a-z]*:begin\$/,/^# flui:fence:[0-9a-z]*:end\$/d' \$PGDATA/pg_hba.conf"
[ "$(sql $S -c 'SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL')" = 0 ] || fail "promoted pg_hba.conf does not parse"
sql $S -c 'SELECT pg_reload_conf()' >/dev/null
$ENGINE exec $P psql "host=$S user=app password=apppw dbname=app sslmode=disable" -tAc 'SELECT count(*) FROM t' | grep -qx 2001 \
  || fail "the promoted copy does not take the source's password over TCP"
pass "promote confirmed; the copy is writable with the source's credentials"

# Abort before any file arrived: the container never starts a database.
$ENGINE run -d --name $A --network $NET -e POSTGRES_USER=app -e POSTGRES_PASSWORD=x \
  -e POSTGRES_DB=app -e PGDATA=$PGDATA -e FLUI_PG_STANDBY=1 "$IMAGE" >/dev/null
sleep 4
$ENGINE exec $A sh -c "touch $PVC/flui-standby/aborted"
wait_for "abort noticed" 20 sh -c "$ENGINE logs $A 2>&1 | grep -q 'migration aborted'"
$ENGINE exec $A test ! -e $PGDATA/PG_VERSION || fail "an aborted standby initialised a database"
pass "an aborted standby never starts"

START=$(date +%s)
$ENGINE stop -t 20 $A >/dev/null
[ $(($(date +%s) - START)) -lt 8 ] || fail "a waiting standby ignored SIGTERM"
pass "a waiting standby stops at once on SIGTERM"

echo "all standby-bootstrap checks passed"
