import {
  restoreContainerName,
  trimTrailingDashes,
} from './rebuild-restore.util';

describe('trimTrailingDashes', () => {
  it.each([
    ['abc', 'abc'],
    ['abc-', 'abc'],
    ['abc---', 'abc'],
    ['a-b-c', 'a-b-c'],
    ['---', ''],
    ['', ''],
    ['-a-', '-a'],
  ])('%j → %j, trailing dashes trimmed', (input, expected) => {
    expect(trimTrailingDashes(input)).toBe(expected);
  });

  it('stays linear on a long run of dashes that does not end the string', () => {
    const input = `${'-'.repeat(100_000)}x`;
    const started = Date.now();
    expect(trimTrailingDashes(input)).toBe(input);
    expect(Date.now() - started).toBeLessThan(100);
  });
});

describe('restoreContainerName', () => {
  it('keeps a name that is already a DNS label', () => {
    expect(restoreContainerName('data')).toBe('flui-restore-data');
  });

  it('hashes a name that is not, without a trailing dash before the digest', () => {
    const name = restoreContainerName(`${'a'.repeat(40)}_${'-'.repeat(30)}x`);
    expect(name).toMatch(/^flui-restore-a+-[0-9a-f]{6}$/);
    expect(name.length).toBeLessThanOrEqual(63);
  });

  it('rejects a label ending in a dash', () => {
    expect(restoreContainerName('data-')).toMatch(
      /^flui-restore-data-[0-9a-f]{6}$/,
    );
  });
});
