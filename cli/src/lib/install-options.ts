/**
 * `--option key=true|false`, repeatable: the install-time switches a catalog
 * app declares (`flui catalog list` and the detail show them). Anything but a
 * boolean is refused here, before the request.
 */
export function parseInstallOptions(
  pairs: string[] | undefined,
): Record<string, boolean> | undefined {
  if (!pairs?.length) return undefined;
  const out: Record<string, boolean> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    const key = eq < 1 ? '' : pair.slice(0, eq).trim();
    const value =
      eq < 1
        ? ''
        : pair
            .slice(eq + 1)
            .trim()
            .toLowerCase();
    if (!key || (value !== 'true' && value !== 'false')) {
      throw new Error(`Expected --option key=true|false, got "${pair}"`);
    }
    out[key] = value === 'true';
  }
  return out;
}
