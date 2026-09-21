import { judgeReleasable } from './version-releasability';

/**
 * Both blocked cases are ones a live installation actually offered: a
 * production application was listed an image built on `staging`, carrying the
 * `latest` tag, with a Deploy button beside it.
 */
describe('deciding which versions an application may be offered', () => {
  const onMain = {
    branch: 'main',
    recordedBranch: () => 'main',
  };

  it('offers a build of the branch it deploys', () => {
    expect(
      judgeReleasable({ tag: 'b136247', digest: 'sha256:aa' }, onMain)
        .releasable,
    ).toBe(true);
  });

  it('refuses a build of another branch, and says which', () => {
    const verdict = judgeReleasable(
      { tag: 'f24c177', digest: 'sha256:bb' },
      { branch: 'main', recordedBranch: () => 'staging' },
    );
    expect(verdict.releasable).toBe(false);
    expect(verdict.reason).toContain('staging');
    expect(verdict.reason).toContain('main');
  });

  /**
   * The point of the whole exercise: nothing on file must read as "another
   * branch", or every application whose builds predate the record loses its
   * list.
   */
  it('keeps a version whose branch was never recorded', () => {
    expect(
      judgeReleasable(
        { tag: '779a601', digest: 'sha256:cc' },
        { branch: 'main', recordedBranch: () => null },
      ).releasable,
    ).toBe(true);
  });

  it('refuses a row that is only a moving tag', () => {
    const verdict = judgeReleasable(
      { tag: 'latest', allTags: ['latest'] },
      onMain,
    );
    expect(verdict.releasable).toBe(false);
    expect(verdict.reason).toContain('built last');
  });

  /** `latest` beside a commit tag is a label on a real version, not a problem. */
  it('keeps a version that merely also carries latest', () => {
    expect(
      judgeReleasable(
        { tag: 'b136247', allTags: ['b136247', 'latest'], digest: 'sha256:aa' },
        onMain,
      ).releasable,
    ).toBe(true);
  });

  /** An untagged digest is the most immutable name there is. */
  it('keeps a version identified only by its digest', () => {
    expect(
      judgeReleasable({ tag: 'c2f221ab9139', digest: 'sha256:c2f221' }, onMain)
        .releasable,
    ).toBe(true);
  });

  it('claims nothing when the application declares no branch', () => {
    expect(
      judgeReleasable(
        { tag: 'v1.2.3', digest: 'sha256:dd' },
        { branch: null, recordedBranch: () => 'staging' },
      ).releasable,
    ).toBe(true);
  });
});
