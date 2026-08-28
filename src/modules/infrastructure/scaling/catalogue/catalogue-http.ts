import { Injectable } from '@nestjs/common';

export const CATALOGUE_HTTP = 'CATALOGUE_HTTP';

/**
 * The one place this slice touches the network.
 *
 * A door rather than a call, so the three answers that decide whether the
 * integration is honest — silence, nonsense, and a reading from an hour ago —
 * can be exercised without a socket.
 */
export interface CatalogueHttp {
  getJson(url: string, timeoutMs: number): Promise<unknown>;
}

@Injectable()
export class FetchCatalogueHttp implements CatalogueHttp {
  /**
   * No credential is ever attached. The reads this slice makes are public, and
   * they carry nothing out of the installation but the provider name — no
   * token, no identity, nothing that says which installation asked.
   */
  async getJson(url: string, timeoutMs: number): Promise<unknown> {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`the catalogue answered HTTP ${response.status}`);
    }
    const text = await response.text();
    return text ? (JSON.parse(text) as unknown) : null;
  }
}
