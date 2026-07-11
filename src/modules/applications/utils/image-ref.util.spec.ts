import { composeGhcrImageRef } from './image-ref.util';

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
