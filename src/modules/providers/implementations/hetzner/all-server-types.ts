import {
  ListServerTypes200ResponseServerTypesInner,
  ServerTypesApi,
} from './generated';

/** The largest page Hetzner serves. */
const PER_PAGE = 50;

/**
 * Every server type Hetzner offers, across all pages.
 *
 * The endpoint pages at 25 by default, and the catalogue has grown past that:
 * a single call silently drops whatever lands on page two — which is where the
 * newest types sort — so a machine Flui can buy never appears to choose from.
 */
export async function allServerTypes(
  api: ServerTypesApi,
): Promise<ListServerTypes200ResponseServerTypesInner[]> {
  const all: ListServerTypes200ResponseServerTypesInner[] = [];
  for (let page = 1; ; page++) {
    const { data } = await api.listServerTypes(undefined, page, PER_PAGE);
    all.push(...data.server_types);
    const last = data.meta?.pagination?.last_page ?? page;
    if (page >= last || data.server_types.length === 0) return all;
  }
}
