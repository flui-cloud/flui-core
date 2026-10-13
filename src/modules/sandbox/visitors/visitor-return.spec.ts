import { dashboardUrl, safeReturnPath } from './visitor-return';

describe('safeReturnPath', () => {
  it('keeps a path of the dashboard, query included', () => {
    expect(safeReturnPath('/applications/new?from=catalog')).toBe(
      '/applications/new?from=catalog',
    );
  });

  it.each([
    'https://evil.example/',
    '//evil.example/x',
    '/\\evil.example',
    'applications',
    'javascript:alert(1)',
    '/a\nb',
    `/${'a'.repeat(600)}`,
    42,
    undefined,
  ])('drops %p', (raw) => {
    expect(safeReturnPath(raw)).toBeNull();
  });

  it('strips the parameters the visitor flow itself adds', () => {
    expect(safeReturnPath('/apps?visitor=finish&flow=abc&tab=1')).toBe(
      '/apps?tab=1',
    );
  });
});

describe('dashboardUrl', () => {
  const config = { dashboardOrigin: 'https://try.flui.cloud' };

  it('always lands on the dashboard origin', () => {
    expect(
      dashboardUrl(config, '//evil.example/x', { visitor: 'upgrade-failed' }),
    ).toBe('https://try.flui.cloud/?visitor=upgrade-failed');
  });

  it('adds the outcome to the path to come back to', () => {
    expect(
      dashboardUrl(config, '/catalog/x?tab=a', {
        visitor: 'finish',
        flow: 'f1',
      }),
    ).toBe('https://try.flui.cloud/catalog/x?tab=a&visitor=finish&flow=f1');
  });

  it('drops a path that grows past the limit once normalised', () => {
    const raw = `/${'é'.repeat(200)}`;
    expect(raw.length).toBeLessThanOrEqual(512);
    expect(safeReturnPath(raw)).toBeNull();
  });
});
