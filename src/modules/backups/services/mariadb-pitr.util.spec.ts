import { buildRestoreEnv } from './mariadb-pitr.util';

const dest = (pathPrefix: string | undefined) => ({
  endpoint: 'https://s3.example',
  bucket: 'b',
  region: 'r',
  forcePathStyle: true,
  pathPrefix,
});

describe('buildRestoreEnv — destination prefix', () => {
  it.each([
    [undefined, 'mariadb/app-1/g1/'],
    ['', 'mariadb/app-1/g1/'],
    ['/', 'mariadb/app-1/g1/'],
    ['///', 'mariadb/app-1/g1/'],
    ['flui', 'flui/mariadb/app-1/g1/'],
    ['/flui/', 'flui/mariadb/app-1/g1/'],
    ['//a/b//', 'a/b/mariadb/app-1/g1/'],
  ])('%j → %j, leading and trailing slashes trimmed', (prefix, expected) => {
    const env = buildRestoreEnv(
      'app-1',
      dest(prefix) as never,
      { accessKey: 'k', secretKey: 's' },
      { generation: 'g1' },
    );
    expect(env.FLUI_MARIADB_S3_PATH).toBe(expected);
  });

  it('stays linear on a long run of slashes inside the prefix', () => {
    const started = Date.now();
    const env = buildRestoreEnv(
      'app-1',
      dest(`a${'/'.repeat(100_000)}b`) as never,
      { accessKey: 'k', secretKey: 's' },
    );
    expect(env.FLUI_MARIADB_S3_PATH.startsWith('a/')).toBe(true);
    expect(Date.now() - started).toBeLessThan(200);
  });
});
