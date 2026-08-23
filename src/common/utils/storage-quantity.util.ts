/**
 * Kubernetes storage quantities, in and out.
 *
 * `10Gi` is what a PersistentVolumeClaim asks for and `10 GiB` is what a person
 * about to lose it needs to read. Both directions live here because the two
 * halves have to agree: a preview that says "10 GiB" and a sweep that deletes
 * something else is worse than saying nothing.
 */

const UNIT_MULTIPLIER: Record<string, number> = {
  '': 1,
  m: 1e-3,
  K: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  Ei: 1024 ** 6,
};

/** Bytes for a quantity like `10Gi`, `500M` or `1024`. Unparseable input is 0. */
export function parseStorageQuantityToBytes(
  quantity: string | undefined | null,
): number {
  if (!quantity) return 0;
  const match = /^(\d+(?:\.\d+)?)([munKMGTPE]i?)?$/.exec(quantity.trim());
  if (!match) return 0;
  const multiplier = UNIT_MULTIPLIER[match[2] ?? ''];
  if (multiplier === undefined) return 0;
  return Number.parseFloat(match[1]) * multiplier;
}

const BINARY_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;

/** A human-readable size, binary units — the ones Kubernetes actually means. */
export function formatStorageBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BINARY_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const rounded =
    value >= 100 || unit === 0
      ? Math.round(value)
      : Math.round(value * 10) / 10;
  return `${rounded} ${BINARY_UNITS[unit]}`;
}
