import { CatalogAppType } from '../enums/catalog-app-type.enum';

interface ExposureSpec {
  type: string;
  exposure?: 'public' | 'internal';
  privatizable?: boolean;
}

export interface CatalogExposure {
  /** What the manifest says. */
  manifest: 'public' | 'internal';
  /** Whether an install may ask for `internal` instead. */
  privatizable: boolean;
  /** What this install gets. */
  effective: 'public' | 'internal';
}

/**
 * How a catalog app is reached once installed. One reading for the installer,
 * which refuses a request it cannot honour, and the processor, which applies it
 * — so an install asked to be internal is never built public in silence.
 */
export function catalogExposure(
  spec: ExposureSpec,
  appType: string,
  requested?: 'public' | 'internal',
): CatalogExposure {
  const standalone = spec.type === CatalogAppType.STANDALONE;
  const buildingBlock = appType === CatalogAppType.BUILDING_BLOCK;
  const manifest = standalone ? (spec.exposure ?? 'public') : 'public';
  const privatizable =
    !buildingBlock &&
    standalone &&
    manifest !== 'internal' &&
    spec.privatizable !== false;
  const effective =
    privatizable && requested === 'internal' ? 'internal' : manifest;
  return { manifest, privatizable, effective };
}

/** Why a requested exposure cannot be honoured, or null when it can. */
export function exposureRefusal(
  spec: ExposureSpec,
  appType: string,
  requested: 'public' | 'internal' | undefined,
): string | null {
  if (!requested) return null;
  const { manifest, privatizable, effective } = catalogExposure(
    spec,
    appType,
    requested,
  );
  if (effective === requested) return null;
  if (manifest === 'internal') {
    return 'This app is reached only from inside Flui and cannot be made public.';
  }
  if (appType === CatalogAppType.BUILDING_BLOCK) {
    return 'A building block is reached only by the apps on its cluster; it has no public or internal address to choose.';
  }
  if (spec.type !== CatalogAppType.STANDALONE) {
    return 'This app is made of several components and cannot be installed as internal: it would be public. Install it without --exposure internal, or pick a single-component app.';
  }
  return privatizable
    ? null
    : 'This app does not support internal exposure (its manifest says privatizable: false): it would be public.';
}
