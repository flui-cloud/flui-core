import { ApplicationExposure } from '../enums/application-exposure.enum';

export const CATALOG_INSTALL_LABEL = 'flui.cloud/catalog-install';

export interface GroupableApp {
  id: string;
  slug: string;
  exposure?: string | null;
  metadata?: Record<string, string> | null;
  labels?: Record<string, string> | null;
}

export function installIdOf(app: GroupableApp): string | undefined {
  return (
    app.metadata?.catalogInstallId ??
    app.labels?.[CATALOG_INSTALL_LABEL] ??
    undefined
  );
}

/**
 * The component that stands for a composed install: the one serving the
 * install's name, else the first public one, else the first.
 */
export function pickPrimaryComponent<T extends GroupableApp>(
  resolvedFqdn: string | null | undefined,
  components: T[],
): T | undefined {
  if (resolvedFqdn) {
    const byFqdn = components.find((c) =>
      resolvedFqdn.startsWith(`${c.slug}.`),
    );
    if (byFqdn) return byFqdn;
  }
  return (
    components.find((c) => c.exposure === ApplicationExposure.PUBLIC) ??
    components[0]
  );
}
