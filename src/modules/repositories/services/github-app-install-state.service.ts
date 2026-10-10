import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CacheService } from '../../common/cache/cache.service';

export interface ConsumedState {
  fluiUserId: string;
  cliCallbackUrl?: string;
}

export interface PendingConnection {
  fluiUserId: string;
  code: string;
  installationId: string | null;
}

const TTL_SECONDS = 10 * 60;
const CLAIM_TTL_SECONDS = 5 * 60;
const key = (state: string) => `github-install-state:${state}`;
const claimKey = (claim: string) => `github-install-claim:${claim}`;

/**
 * OAuth install `state` tokens that tie an "Install Flui App" click to the
 * GitHub callback. Kept in the shared cache: the callback may reach a
 * different copy of the API than the one that issued the state. Single-use,
 * and gone after ten minutes.
 */
@Injectable()
export class GithubAppInstallStateService {
  constructor(private readonly cache: CacheService) {}

  async issue(fluiUserId: string, cliCallbackUrl?: string): Promise<string> {
    const state = randomUUID();
    await this.cache.set<ConsumedState>(
      key(state),
      { fluiUserId, cliCallbackUrl },
      { ttl: TTL_SECONDS },
    );
    return state;
  }

  /** The entry, removed as it is read; null when missing or expired. */
  async consume(state: string): Promise<ConsumedState | null> {
    const entry = await this.cache.get<ConsumedState>(key(state));
    if (!entry) return null;
    await this.cache.delete(key(state));
    return entry;
  }

  /**
   * What GitHub sent back, held until the client that started the connection
   * claims it while signed in. The callback is opened by whatever browser
   * follows the link, which need not be the person who asked for it.
   */
  async hold(pending: PendingConnection): Promise<string> {
    const claim = randomUUID();
    await this.cache.set<PendingConnection>(claimKey(claim), pending, {
      ttl: CLAIM_TTL_SECONDS,
    });
    return claim;
  }

  async take(claim: string): Promise<PendingConnection | null> {
    const entry = await this.cache.get<PendingConnection>(claimKey(claim));
    if (!entry) return null;
    await this.cache.delete(claimKey(claim));
    return entry;
  }
}
