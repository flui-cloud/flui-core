import {
  OrderableVersion,
  parseSemverTag,
  sortVersionsForDisplay,
} from './version-ordering.util';

const v = (
  tag: string,
  createdAt: string,
  isCurrentlyDeployed = false,
): OrderableVersion => ({ tag, createdAt, isCurrentlyDeployed });

describe('sortVersionsForDisplay', () => {
  it('floats a freshly tagged semver release above the per-commit SHA builds', () => {
    const list = [
      v('4c30a51', '2026-06-30T09:25:00Z'),
      v('9691aa6', '2026-06-29T12:00:00Z'),
      v('0.10.2', '2026-06-30T10:17:00Z'),
      v('0.10.1', '2026-06-20T08:00:00Z'),
    ];
    expect(sortVersionsForDisplay(list).map((x) => x.tag)).toEqual([
      '0.10.2',
      '0.10.1',
      '4c30a51',
      '9691aa6',
    ]);
  });

  it('keeps the running version at the very top, even if it is a SHA', () => {
    const list = [
      v('0.10.2', '2026-06-30T10:17:00Z'),
      v('4c30a51', '2026-06-30T09:25:00Z', true),
    ];
    expect(sortVersionsForDisplay(list)[0].tag).toBe('4c30a51');
  });

  it('orders semver highest-first', () => {
    const list = [v('0.9.0', 'x'), v('0.10.2', 'x'), v('0.10.1', 'x')];
    expect(sortVersionsForDisplay(list).map((x) => x.tag)).toEqual([
      '0.10.2',
      '0.10.1',
      '0.9.0',
    ]);
  });

  it('orders non-semver builds newest-first', () => {
    const list = [
      v('aaaaaaa', '2026-06-01T00:00:00Z'),
      v('bbbbbbb', '2026-06-30T00:00:00Z'),
    ];
    expect(sortVersionsForDisplay(list).map((x) => x.tag)).toEqual([
      'bbbbbbb',
      'aaaaaaa',
    ]);
  });

  it('does not mutate the input array', () => {
    const list = [v('0.10.1', 'x'), v('0.10.2', 'x')];
    const before = list.map((x) => x.tag);
    sortVersionsForDisplay(list);
    expect(list.map((x) => x.tag)).toEqual(before);
  });
});

describe('parseSemverTag', () => {
  it('parses semver and rejects SHA / named tags', () => {
    expect(parseSemverTag('0.10.2')).toEqual([0, 10, 2]);
    expect(parseSemverTag('v1.2.3')).toEqual([1, 2, 3]);
    expect(parseSemverTag('0.10')).toEqual([0, 10, 0]);
    expect(parseSemverTag('4c30a51')).toBeNull();
    expect(parseSemverTag('latest')).toBeNull();
  });
});
