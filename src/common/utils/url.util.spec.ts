import { stripTrailingSlashes } from './url.util';

describe('stripTrailingSlashes', () => {
  it.each([
    '',
    '/',
    '///',
    'apps/demo',
    'apps/demo/',
    'apps/demo///',
    '/apps//demo//',
    'a/b/c',
  ])('matches the trailing-slash regex for %p', (value) => {
    expect(stripTrailingSlashes(value)).toBe(value.replace(/\/+$/, ''));
  });

  it('handles a long run of slashes in linear time', () => {
    const value = `prefix${'/'.repeat(100_000)}x${'/'.repeat(100_000)}`;
    expect(stripTrailingSlashes(value)).toBe(`prefix${'/'.repeat(100_000)}x`);
  });
});
