import { assertIp } from '../services/db-overlay-transport.service';

export interface PhysicalNames {
  short: string;
  role: string;
  slot: string;
  application: string;
  service: string;
  netpol: string;
  replMarker: string;
  fenceMarker: string;
  fwdMarker: string;
  fwdNetpol: string;
}

export function physicalNames(linkId: string): PhysicalNames {
  const short = linkId.replaceAll('-', '').slice(0, 12);
  return {
    short,
    role: `flui_repl_${short}`,
    slot: `flui_phys_${short}`,
    application: `flui_mig_${short}`,
    service: `flui-repl-${short}`,
    netpol: `flui-db-repl-${short}`,
    replMarker: `flui:repl:${short}`,
    fenceMarker: `flui:fence:${short}`,
    fwdMarker: `flui:fwd:${short}`,
    fwdNetpol: `flui-db-fwd-${short}`,
  };
}

export class SlotLostError extends Error {}
export class PromoteUnconfirmedError extends Error {}

export type RecoveryState = 'standby' | 'primary' | 'unknown';

export interface PhysicalStatusView {
  state: string | null;
  replayLagBytes: number | null;
  slotActive: boolean;
  walStatus: string | null;
  retainedBytes: number | null;
}

export interface StandbyState {
  done: boolean;
  inRecovery: boolean | null;
}

/** Prints the checksum of the file without the block, so a re-run keeps the original. */
export function replicationHbaScript(
  marker: string,
  role: string,
  dstOverlayIp: string,
): string {
  assertIp(dstOverlayIp);
  const begin = `# ${marker}:begin`;
  const end = `# ${marker}:end`;
  return [
    'set -e',
    'HBA="$PGDATA/pg_hba.conf"',
    `BEFORE=$(sed '/^${begin}$/,/^${end}$/d' "$HBA" | sha256sum | cut -d' ' -f1)`,
    `if ! grep -qx '${begin}' "$HBA"; then`,
    String.raw`  { printf '${begin}\nhostssl   replication ${role} ${dstOverlayIp}/32 scram-sha-256\nhostnossl replication all 0.0.0.0/0 reject\n${end}\n'`,
    '    cat "$HBA"; } > "$HBA.flui" && chown postgres:postgres "$HBA.flui" && chmod 600 "$HBA.flui" && mv "$HBA.flui" "$HBA"',
    'fi',
    'echo "FLUI_HBA_BEFORE=$BEFORE"',
  ].join('\n');
}

export function removeHbaBlockScript(marker: string): string {
  return [
    'set -e',
    'HBA="$PGDATA/pg_hba.conf"',
    `sed -i '/^# ${marker}:begin$/,/^# ${marker}:end$/d' "$HBA"`,
    'chown postgres:postgres "$HBA"',
    'echo "FLUI_HBA_AFTER=$(sha256sum "$HBA" | cut -d\' \' -f1)"',
  ].join('\n');
}

/** Every block a promoted copy inherited from the source's `pg_hba.conf`. */
export const PROMOTED_HBA_CLEANUP_SCRIPT = [
  'set -e',
  'HBA="$PGDATA/pg_hba.conf"',
  "sed -i -e '/^# flui:repl:[0-9a-z]*:begin$/,/^# flui:repl:[0-9a-z]*:end$/d'" +
    " -e '/^# flui:fence:[0-9a-z]*:begin$/,/^# flui:fence:[0-9a-z]*:end$/d'" +
    " -e '/^# flui:fwd:[0-9a-z]*:begin$/,/^# flui:fwd:[0-9a-z]*:end$/d'" +
    String.raw` -e '/^hostnossl all flui_repl 0\.0\.0\.0\/0 reject$/d'` +
    String.raw` -e '/^hostnossl all flui_repl ::0\/0 reject$/d' "$HBA"`,
  'chown postgres:postgres "$HBA"',
].join('\n');

/**
 * Settings the base backup carried over from the source that a promoted copy
 * must not keep. TLS is reset only when Flui turned it on; the owner's own TLS
 * settings stay, behind the `ssl = off` the standby bootstrap appended.
 */
export function promotedSettingsResetSql(sslSetByFlui: boolean): string {
  return [
    'ALTER SYSTEM RESET primary_conninfo;',
    'ALTER SYSTEM RESET primary_slot_name;',
    'ALTER SYSTEM RESET default_transaction_read_only;',
    ...(sslSetByFlui
      ? [
          'ALTER SYSTEM RESET ssl;',
          'ALTER SYSTEM RESET ssl_cert_file;',
          'ALTER SYSTEM RESET ssl_key_file;',
        ]
      : []),
    'ALTER SYSTEM RESET archive_command;',
    'ALTER SYSTEM RESET max_slot_wal_keep_size;',
    'SELECT pg_reload_conf();',
  ].join('\n');
}

export function field(out: string, name: string): string | undefined {
  return out
    .split('\n')
    .find((l) => l.startsWith(`${name}=`))
    ?.slice(name.length + 1)
    .trim();
}
