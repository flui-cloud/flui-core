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

export interface DependencyChoiceInput {
  alias: string;
  mode: 'DEDICATED' | 'REUSE_EXISTING';
  existingApplicationId?: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `alias=new` installs a dedicated block, `alias=<application id>` reuses one. */
export function parseDependencyChoices(
  pairs: string[] | undefined,
): DependencyChoiceInput[] | undefined {
  if (!pairs?.length) return undefined;
  return pairs.map((pair) => {
    const eq = pair.indexOf('=');
    const alias = eq < 1 ? '' : pair.slice(0, eq).trim();
    const target = eq < 1 ? '' : pair.slice(eq + 1).trim();
    if (!alias || !target) {
      throw new Error(
        `Expected --dependency alias=new|<application id>, got "${pair}"`,
      );
    }
    if (target.toLowerCase() === 'new') return { alias, mode: 'DEDICATED' };
    if (!UUID_RE.test(target)) {
      throw new Error(
        `--dependency ${alias}: "${target}" is neither "new" nor an application id`,
      );
    }
    return { alias, mode: 'REUSE_EXISTING', existingApplicationId: target };
  });
}
