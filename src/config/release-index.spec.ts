import * as fs from 'node:fs';
import * as path from 'node:path';
import { RELEASE } from './release.config';
import { compareVersions } from '../modules/platform-updates/utils/version-compare';

/**
 * The guard that makes `releases.json` a publication rather than a second place
 * to write versions down.
 *
 * `RELEASE` is authored; the index is generated from it by `pnpm release:index`
 * and published so an installation can learn what exists after the release it
 * was compiled as. Two files can drift, so this asks the only question that
 * matters: does the index still say about this release exactly what the
 * constant says? Failing here means running the generator, not editing JSON.
 */
interface Entry {
  version: string;
  publishedAt: string;
  bootstrapRef: string;
  images: Record<string, string>;
  notes: string[];
  migrations: number;
  requiresBootstrap: boolean;
}

const INDEX = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../releases.json'), 'utf8'),
) as { schemaVersion: number; releases: Entry[] };

describe('the published release index', () => {
  it('carries an entry for the release this build is', () => {
    const versions = INDEX.releases.map((r) => r.version);
    expect(versions).toContain(RELEASE.version);
  });

  it('says the same thing as RELEASE about that entry', () => {
    const entry = INDEX.releases.find((r) => r.version === RELEASE.version)!;
    expect(entry.bootstrapRef).toBe(RELEASE.bootstrapRef);
    expect(entry.images).toEqual({ ...RELEASE.images });
  });

  it('names every release once', () => {
    const versions = INDEX.releases.map((r) => r.version);
    expect(versions.length).toBe(new Set(versions).size);
  });

  it('carries what an installation needs to decide, on every entry', () => {
    for (const entry of INDEX.releases) {
      expect(typeof entry.publishedAt).toBe('string');
      expect(typeof entry.migrations).toBe('number');
      expect(typeof entry.requiresBootstrap).toBe('boolean');
      expect(Array.isArray(entry.notes)).toBe(true);
      expect(
        Object.keys(entry.images).sort((a, b) => a.localeCompare(b)),
      ).toEqual(['fluiApi', 'fluiAuthz', 'fluiWeb']);
      // Every version has to be orderable, or the newest cannot be found.
      expect(compareVersions(entry.version, '0.0.0')).not.toBeNull();
    }
  });
});
