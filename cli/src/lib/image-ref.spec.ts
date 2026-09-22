import { composeImageRef, repositoryOf } from './image-ref';

describe('asking an application to run a different image', () => {
  const current = 'ghcr.io/flui-cloud/dashboard:0.13.0-rc.8';

  it('keeps the repository and swaps the tag', () => {
    expect(composeImageRef(current, '16d2dbd')).toBe(
      'ghcr.io/flui-cloud/dashboard:16d2dbd',
    );
  });

  /** The case that bites: a digest joins with `@`, never with `:`. */
  it('joins a digest with @, not with a colon', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    expect(composeImageRef(current, digest)).toBe(
      `ghcr.io/flui-cloud/dashboard@${digest}`,
    );
  });

  it('reads the repository out of a reference already pinned by digest', () => {
    expect(
      composeImageRef(
        `ghcr.io/flui-cloud/core@sha256:${'b'.repeat(64)}`,
        'abc1234',
      ),
    ).toBe('ghcr.io/flui-cloud/core:abc1234');
  });

  it('passes a full reference through untouched', () => {
    expect(composeImageRef(current, 'ghcr.io/someone/else:v1')).toBe(
      'ghcr.io/someone/else:v1',
    );
  });

  it('says what is missing when the application declares no image', () => {
    expect(() => composeImageRef(undefined, 'abc1234')).toThrow(
      /declares no image/,
    );
  });

  /** A port is not a tag, however much it looks like one. */
  it('does not mistake a registry port for a tag', () => {
    expect(repositoryOf('registry.local:5000/team/app:v2')).toBe(
      'registry.local:5000/team/app',
    );
  });
});
