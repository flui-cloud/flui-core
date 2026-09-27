import { StorageBackendProvider } from '../../storage/enums/storage-backend-provider.enum';

export interface StorageListPrice {
  centsPerGbMonth: number;
  /** Named wherever an estimate uses it, so a stale figure can be recognised. */
  source: string;
}

/**
 * Published prices Flui applies when nothing more specific is known. Dated,
 * because a list price is a fact about one day; a person who pays something
 * else sets it on the destination.
 */
const LIST_PRICES: Partial<Record<StorageBackendProvider, StorageListPrice>> = {
  [StorageBackendProvider.SCALEWAY_OBJECT_STORAGE]: {
    centsPerGbMonth: 1.606,
    source:
      'Scaleway Object Storage, Standard Multi-AZ: €0.01606 per GB per month (list price of 27 Sep 2026)',
  },
};

export function listPriceFor(
  provider: StorageBackendProvider | string,
): StorageListPrice | null {
  return LIST_PRICES[provider as StorageBackendProvider] ?? null;
}
