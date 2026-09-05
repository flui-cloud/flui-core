import { PlatformComponentKey } from '../constants/platform-update-components';

export interface PlatformReleaseEntry {
  version: string;
  publishedAt: string;
  /** bootstrap-scripts ref this release was cut against. */
  bootstrapRef: string;
  images: Record<PlatformComponentKey, string>;
  notes: string[];
  /** Database migrations the new API applies at start-up. */
  migrations: number;
  /**
   * True when the release changes bootstrap manifests and not only image tags.
   * An in-app update can only move tags, so this makes the release explicitly
   * un-appliable from here instead of leaving it to fail halfway.
   */
  requiresBootstrap: boolean;
  /** Oldest installed version that may jump straight to this one. */
  minFrom?: string;
}

export interface PlatformReleaseManifest {
  schemaVersion: number;
  releases: PlatformReleaseEntry[];
}
