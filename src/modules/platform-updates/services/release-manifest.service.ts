import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PlatformReleaseEntry,
  PlatformReleaseManifest,
} from '../interfaces/release-manifest.interface';
import { compareVersions } from '../utils/version-compare';

const DEFAULT_MANIFEST_URL =
  'https://raw.githubusercontent.com/flui-cloud/flui-core/master/releases.json';
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

interface CachedManifest {
  manifest: PlatformReleaseManifest;
  fetchedAt: Date;
}

/**
 * Fetches and caches the published release manifest.
 *
 * The file lives beside `release.config.ts` and is generated from it
 * (`pnpm release:index`), so the release tuple has one author and one
 * publication rather than two places to write it down.
 *
 * Read from `master`, deliberately: the manifest's whole job is to describe
 * releases *newer* than the one this build pins, and a manifest fetched at the
 * installed release's own ref could only ever describe the past.
 */
@Injectable()
export class ReleaseManifestService {
  private readonly logger = new Logger(ReleaseManifestService.name);
  private cache: CachedManifest | null = null;

  constructor(private readonly configService: ConfigService) {}

  private get url(): string {
    return (
      this.configService.get<string>('FLUI_RELEASES_URL') ??
      DEFAULT_MANIFEST_URL
    );
  }

  private get ttlMs(): number {
    const raw = this.configService.get<string>('FLUI_RELEASES_TTL_MS');
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_MS;
  }

  /** Cached fetch. `force` bypasses the TTL — the "Check now" button. */
  async getManifest(
    force = false,
  ): Promise<{ manifest: PlatformReleaseManifest; fetchedAt: Date }> {
    const cached = this.cache;
    const fresh =
      cached && Date.now() - cached.fetchedAt.getTime() < this.ttlMs;
    if (cached && fresh && !force) return cached;

    try {
      const manifest = await this.fetch();
      this.cache = { manifest, fetchedAt: new Date() };
      return this.cache;
    } catch (err) {
      // A stale manifest still answers "is there an update"; only a cold cache
      // leaves the caller with nothing, and that is the caller's to report.
      if (cached) {
        this.logger.warn(
          `Release manifest refresh failed, serving cached copy from ${cached.fetchedAt.toISOString()}: ${(err as Error).message}`,
        );
        return cached;
      }
      throw err;
    }
  }

  private async fetch(): Promise<PlatformReleaseManifest> {
    const response = await fetch(this.url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(
        `Release manifest request failed: HTTP ${response.status} from ${this.url}`,
      );
    }
    return this.validate(await response.json());
  }

  /**
   * Rejects a manifest that does not carry what an update decision needs. The
   * alternative — trusting a half-shaped entry — surfaces as `undefined` image
   * tags in the UI and, worse, as a deploy of the string "undefined".
   */
  private validate(raw: unknown): PlatformReleaseManifest {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error('Release manifest is not an object');
    }
    const doc = raw as Partial<PlatformReleaseManifest>;
    if (!Array.isArray(doc.releases)) {
      throw new Error('Release manifest carries no releases array');
    }
    const releases = doc.releases
      .filter((entry): entry is PlatformReleaseEntry => this.isEntry(entry))
      .sort((a, b) => compareVersions(b.version, a.version) ?? 0);
    if (releases.length === 0) {
      throw new Error('Release manifest carries no usable release entry');
    }
    return { schemaVersion: doc.schemaVersion ?? 1, releases };
  }

  private isEntry(entry: unknown): boolean {
    if (typeof entry !== 'object' || entry === null) return false;
    const e = entry as Partial<PlatformReleaseEntry>;
    const images = e.images as Record<string, unknown> | undefined;
    const hasImages =
      !!images &&
      ['fluiApi', 'fluiWeb', 'fluiAuthz'].every(
        (k) => typeof images[k] === 'string' && images[k] !== '',
      );
    const valid =
      typeof e.version === 'string' && e.version !== '' && hasImages;
    if (!valid) {
      this.logger.warn(
        `Skipping malformed release entry: ${JSON.stringify(entry).slice(0, 200)}`,
      );
    }
    return valid;
  }
}
