import {
  composeGhcrImageRef,
  normalizeMonorepoImageRef,
} from './image-ref.util';

describe('composeGhcrImageRef', () => {
  it('composes a monorepo ref with the subPath segment', () => {
    expect(
      composeGhcrImageRef({
        owner: 'Dawit-IO',
        repoName: 'Vops-Landing',
        subPath: 'API',
        tag: '727dcaa',
      }),
    ).toBe('ghcr.io/dawit-io/vops-landing/api:727dcaa');
  });

  it('omits the segment for a single-app repo', () => {
    expect(
      composeGhcrImageRef({
        owner: 'dawit-io',
        repoName: 'app',
        tag: 'abc1234',
      }),
    ).toBe('ghcr.io/dawit-io/app:abc1234');
  });

  it('treats empty/null subPath as no segment', () => {
    for (const subPath of [undefined, null, '']) {
      expect(
        composeGhcrImageRef({ owner: 'o', repoName: 'r', subPath, tag: 't' }),
      ).toBe('ghcr.io/o/r:t');
    }
  });
});

describe('normalizeMonorepoImageRef', () => {
  it('inserts a missing subPath into a bare tagged ref', () => {
    expect(
      normalizeMonorepoImageRef('ghcr.io/dawit-io/vops-landing:c87c2a4', 'api'),
    ).toBe('ghcr.io/dawit-io/vops-landing/api:c87c2a4');
  });

  it('inserts a missing subPath into a bare digest ref', () => {
    expect(
      normalizeMonorepoImageRef(
        'ghcr.io/dawit-io/vops-landing@sha256:' + 'a'.repeat(64),
        'api',
      ),
    ).toBe('ghcr.io/dawit-io/vops-landing/api@sha256:' + 'a'.repeat(64));
  });

  it('leaves a ref that already carries the subPath untouched', () => {
    const ref = 'ghcr.io/dawit-io/vops-landing/api:c87c2a4';
    expect(normalizeMonorepoImageRef(ref, 'api')).toBe(ref);
  });

  it('does not confuse a different subPath already present', () => {
    // web app must never be rewritten to /web/web
    const ref = 'ghcr.io/dawit-io/vops-landing/web:c87c2a4';
    expect(normalizeMonorepoImageRef(ref, 'web')).toBe(ref);
  });

  it('is a no-op without a subPath (single-app repo)', () => {
    const ref = 'ghcr.io/dawit-io/app:abc1234';
    for (const sub of [undefined, null, '']) {
      expect(normalizeMonorepoImageRef(ref, sub)).toBe(ref);
    }
  });

  it('leaves non-GHCR refs untouched', () => {
    const ref = 'docker.io/library/postgres:17';
    expect(normalizeMonorepoImageRef(ref, 'api')).toBe(ref);
  });

  it('lower-cases the owner/repo segment it rewrites', () => {
    expect(
      normalizeMonorepoImageRef('ghcr.io/Dawit-IO/Vops-Landing:c87c2a4', 'API'),
    ).toBe('ghcr.io/dawit-io/vops-landing/api:c87c2a4');
  });
});
