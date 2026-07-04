#!/usr/bin/env bash
# Runs once, after initdb, while the bootstrap server is up. Appends an include of
# the Flui base config to the freshly generated postgresql.conf. The real server
# (started after this hook) picks it up — so wal_level/archive_mode take effect on
# first real start, no extra restart needed.
set -Eeuo pipefail

CONF="$PGDATA/postgresql.conf"
INCLUDE_LINE="include_if_exists = '/etc/flui/postgresql.flui.conf'"

if ! grep -qF "$INCLUDE_LINE" "$CONF" 2>/dev/null; then
  printf '\n# Flui managed\n%s\n' "$INCLUDE_LINE" >> "$CONF"
fi
