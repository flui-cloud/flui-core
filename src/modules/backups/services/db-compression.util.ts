/**
 * What a database artifact's objects were compressed with, as read back from
 * what the tool wrote rather than from the configuration Flui asked for.
 *
 * `type` is the algorithm under one spelling for every engine (`zstd`, `gzip`,
 * `none`, or the tool's own word when Flui has no mapping for it). `logs` is
 * set when the engine's logs are compressed independently of its base.
 */
export interface ArtifactCompression {
  type: string;
  level?: number;
  blockIncremental?: boolean;
  logs?: string;
}

export const PG_COMPRESS_TYPE = 'zst';
export const PG_COMPRESS_LEVEL = 3;

export const SHIPPER_ZSTD_FEATURE = 'zstd';
export const SHIPPER_ZSTD_LEVEL = 3;
export const ZSTD_SUFFIX = '.zst';

const PGBACKREST_ALGORITHMS: Record<string, string> = {
  zst: 'zstd',
  gz: 'gzip',
  bz2: 'bzip2',
  lz4: 'lz4',
  none: 'none',
};

const PG_BACKUP_LABEL = /^\d{8}-\d{6}F(?:_\d{8}-\d{6}[DI])?$/;

export function isPgBackupLabel(label: string | null | undefined): boolean {
  return !!label && PG_BACKUP_LABEL.test(label);
}

/** The newest backup in `pgbackrest info --output=json` and whether it carries block maps. */
export function latestPgBackup(
  json: string,
  stanza: string,
): { label: string; blockIncremental: boolean } | null {
  try {
    const parsed = JSON.parse(json) as Array<{
      name?: string;
      backup?: Array<{
        label?: string;
        info?: { repository?: Record<string, unknown> };
      }>;
    }>;
    const found = Array.isArray(parsed)
      ? parsed.find((s) => s?.name === stanza)
      : undefined;
    const last = found?.backup?.at(-1);
    if (!last?.label || !isPgBackupLabel(last.label)) return null;
    const repository = last.info?.repository ?? {};
    return {
      label: last.label,
      blockIncremental: typeof repository['size-map'] === 'number',
    };
  } catch {
    return null;
  }
}

/** `option-compress-type` / `option-compress-level` from a backup manifest. */
export function parsePgManifestCompression(
  manifest: string,
  blockIncremental: boolean,
): ArtifactCompression | null {
  const type = /^option-compress-type="?([a-z0-9]+)"?\s*$/m.exec(manifest)?.[1];
  if (!type) return null;
  const level = Number(/^option-compress-level=(\d+)\s*$/m.exec(manifest)?.[1]);
  return {
    type: PGBACKREST_ALGORITHMS[type] ?? type,
    ...(type !== 'none' && Number.isFinite(level) ? { level } : {}),
    blockIncremental,
  };
}

/**
 * The shipper's own report of a base it just wrote: `COMPRESSION=` for the
 * base stream, `LOGS=` for how it ships binary logs. An image that predates
 * compression reports neither, and that is recorded as `none`.
 */
export function parseShipperCompression(out: string): ArtifactCompression {
  const base = /\bCOMPRESSION=(\S+)/.exec(out)?.[1];
  const logs = /\bLOGS=(\S+)/.exec(out)?.[1];
  return {
    type: base === 'zstd' ? 'zstd' : 'none',
    ...(base === 'zstd' ? { level: SHIPPER_ZSTD_LEVEL } : {}),
    logs: logs === 'zstd' ? 'zstd' : 'none',
  };
}
