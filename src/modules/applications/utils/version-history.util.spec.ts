import { curateVersionHistory } from './version-history.util';

const at = (day: number): string =>
  new Date(Date.UTC(2026, 8, day)).toISOString();

const v = (
  tag: string,
  day: number,
  extra: Record<string, unknown> = {},
): {
  tag: string;
  allTags: string[];
  createdAt: string;
  releaseCount: number;
  isCurrentlyDeployed: boolean;
  digest?: string;
} => ({
  tag,
  allTags: [tag],
  createdAt: at(day),
  releaseCount: 0,
  isCurrentlyDeployed: false,
  ...extra,
});

describe('curateVersionHistory', () => {
  it('keeps every named tag and caps the SHA-only tail', () => {
    const versions = [
      v('0.13.0', 1),
      v('latest', 2),
      v('main', 3),
      v('feat-db-console', 4),
      v('aaaaaaa', 5),
      v('bbbbbbb', 6),
      v('ccccccc', 7),
    ];

    const out = curateVersionHistory(versions, 2);

    expect(out.map((x) => x.tag)).toEqual([
      '0.13.0',
      'latest',
      'main',
      'feat-db-console',
      'bbbbbbb',
      'ccccccc',
    ]);
  });

  it('keeps the newest SHA builds, not the first ones listed', () => {
    const out = curateVersionHistory(
      [v('aaaaaaa', 1), v('bbbbbbb', 9), v('ccccccc', 5)],
      1,
    );
    expect(out.map((x) => x.tag)).toEqual(['bbbbbbb']);
  });

  it('never drops a SHA build that was released or is deployed', () => {
    const out = curateVersionHistory(
      [
        v('aaaaaaa', 1, { releaseCount: 2 }),
        v('bbbbbbb', 2, { isCurrentlyDeployed: true }),
        v('ccccccc', 3),
        v('ddddddd', 4),
      ],
      1,
    );
    expect(out.map((x) => x.tag)).toEqual(['aaaaaaa', 'bbbbbbb', 'ddddddd']);
  });

  it('protects refs pinned by tag or by digest', () => {
    const out = curateVersionHistory(
      [
        v('aaaaaaa', 1, { digest: 'sha256:keepme' }),
        v('bbbbbbb', 2),
        v('ccccccc', 3),
      ],
      0,
      { tags: ['bbbbbbb'], digests: ['sha256:keepme'] },
    );
    expect(out.map((x) => x.tag)).toEqual(['aaaaaaa', 'bbbbbbb']);
  });

  it('treats a SHA build that also carries a named tag as named', () => {
    const out = curateVersionHistory(
      [
        { ...v('aaaaaaa', 1), allTags: ['aaaaaaa', '0.13.0-rc.4'] },
        v('bbbbbbb', 2),
      ],
      0,
    );
    expect(out.map((x) => x.tag)).toEqual(['aaaaaaa']);
  });

  it('treats a full 40-char commit SHA as anonymous too', () => {
    const out = curateVersionHistory(
      [
        v('e70ce48cb81ffe34d8e03c4cff930f33edb70834', 1),
        v('f3a0ff3c12a6f7399d1243c2b75f7daf0fe13829', 2),
        v('0.13.0', 3),
      ],
      1,
    );
    expect(out.map((x) => x.tag)).toEqual([
      'f3a0ff3c12a6f7399d1243c2b75f7daf0fe13829',
      '0.13.0',
    ]);
  });

  it('preserves the incoming order of what it keeps', () => {
    const out = curateVersionHistory(
      [v('ccccccc', 3), v('aaaaaaa', 1), v('bbbbbbb', 2)],
      2,
    );
    expect(out.map((x) => x.tag)).toEqual(['ccccccc', 'bbbbbbb']);
  });

  it('returns everything when the limit exceeds the tail', () => {
    const versions = [v('aaaaaaa', 1), v('bbbbbbb', 2)];
    expect(curateVersionHistory(versions, 50)).toHaveLength(2);
  });
});
