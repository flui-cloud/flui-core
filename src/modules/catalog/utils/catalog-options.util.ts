import { CatalogAppType } from '../enums/catalog-app-type.enum';
import {
  CatalogOption,
  CatalogSpec,
} from '../interfaces/catalog-manifest.interface';
import {
  PoolerMode,
  PoolerSpec,
} from '../../applications/utils/db-pooler.core';

export const POOLER_OPTION = 'pooler';
export const POOLER_SESSION_MODE_OPTION = 'poolerSessionMode';
/** The one catalog app whose seed declares the pooler options. */
export const POOLED_CATALOG_SLUG = 'postgresql';

/** The install-time switches a manifest declares, on a composed app or a building block. */
export function declaredOptions(spec: CatalogSpec): CatalogOption[] {
  if (
    spec.type === CatalogAppType.COMPOSED ||
    spec.type === CatalogAppType.BUILDING_BLOCK
  ) {
    return spec.options ?? [];
  }
  return [];
}

/** What a chosen value, or the declared default when nothing was chosen, says about one option. */
export function isOptionOn(
  spec: CatalogSpec,
  chosen: Record<string, boolean> | null | undefined,
  key: string,
): boolean {
  const option = declaredOptions(spec).find((o) => o.key === key);
  if (option?.requires && !isOptionOn(spec, chosen, option.requires)) {
    return false;
  }
  const value = chosen?.[key];
  if (typeof value === 'boolean') return value;
  return option?.default ?? false;
}

/**
 * Every declared option written out as the boolean it resolves to, so nothing
 * read later depends on the fallback to a default: a default that changes, or
 * an option added to the manifest after the install, must not change what an
 * existing install reads.
 */
export function resolveInstallOptions(
  spec: CatalogSpec,
  chosen: Record<string, boolean> | null | undefined,
): Record<string, boolean> {
  const out: Record<string, boolean> = { ...chosen };
  for (const option of declaredOptions(spec)) {
    out[option.key] = isOptionOn(spec, chosen, option.key);
  }
  return out;
}

/**
 * The pooler an install asks for, or null: only a PostgreSQL building block
 * that declares the `pooler` option can have one.
 */
export function poolerChoice(
  spec: CatalogSpec,
  chosen: Record<string, boolean> | null | undefined,
): { mode: PoolerMode } | null {
  if (
    spec.type !== CatalogAppType.BUILDING_BLOCK ||
    spec.engine !== 'postgres' ||
    !declaredOptions(spec).some((o) => o.key === POOLER_OPTION) ||
    !isOptionOn(spec, chosen, POOLER_OPTION)
  ) {
    return null;
  }
  return {
    mode: isOptionOn(spec, chosen, POOLER_SESSION_MODE_OPTION)
      ? 'session'
      : 'transaction',
  };
}

/**
 * The pooler options an internal install states when it makes a copy of an
 * existing database: the source's own pooler, or none when the source had
 * none or is unknown.
 */
export function mirrorPoolerOptions(
  source: { pooler?: PoolerSpec | null } | null | undefined,
): Record<string, boolean> {
  const pooler = source?.pooler?.enabled ? source.pooler : null;
  return {
    [POOLER_OPTION]: !!pooler,
    [POOLER_SESSION_MODE_OPTION]: pooler?.mode === 'session',
  };
}
