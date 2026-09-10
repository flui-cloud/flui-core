import { mergeLinkEnv } from './env-merge.util';
import { ApplicationEnvVar } from '../interfaces/source-config.interface';

describe('mergeLinkEnv', () => {
  const ref = { secretName: 'pg-secret', key: 'FLUI_CONNECTION_URL' };

  it('adds the attachment env without touching what the manifest owns', () => {
    const existing: ApplicationEnvVar[] = [
      { name: 'NODE_ENV', value: 'production', source: 'manifest' },
    ];
    expect(
      mergeLinkEnv(
        existing,
        [
          {
            name: 'DATABASE_URL',
            value: '',
            secret: true,
            externalSecretRef: ref,
          },
        ],
        ['DATABASE_URL'],
      ),
    ).toEqual([
      { name: 'NODE_ENV', value: 'production', source: 'manifest' },
      {
        name: 'DATABASE_URL',
        value: '',
        source: 'link',
        secret: true,
        externalSecretRef: ref,
      },
    ]);
  });

  it('replaces its own reference when the block behind it changed', () => {
    const existing: ApplicationEnvVar[] = [
      {
        name: 'DATABASE_URL',
        value: '',
        source: 'link',
        secret: true,
        externalSecretRef: { secretName: 'old-secret', key: 'X' },
      },
    ];
    const [entry] = mergeLinkEnv(
      existing,
      [
        {
          name: 'DATABASE_URL',
          value: '',
          secret: true,
          externalSecretRef: ref,
        },
      ],
      ['DATABASE_URL'],
    );
    expect(entry.externalSecretRef).toEqual(ref);
  });

  it('drops a link it owned and stopped declaring', () => {
    const existing: ApplicationEnvVar[] = [
      {
        name: 'CACHE_URL',
        value: '',
        source: 'link',
        secret: true,
        externalSecretRef: { secretName: 'redis-secret', key: 'K' },
      },
      { name: 'NODE_ENV', value: 'production', source: 'manifest' },
    ];
    expect(mergeLinkEnv(existing, [], ['CACHE_URL'])).toEqual([
      { name: 'NODE_ENV', value: 'production', source: 'manifest' },
    ]);
  });

  it('leaves a link it does not own alone', () => {
    const existing: ApplicationEnvVar[] = [
      {
        name: 'PGWEB_URL',
        value: '',
        source: 'link',
        secret: true,
        externalSecretRef: { secretName: 'other', key: 'K' },
      },
    ];
    expect(mergeLinkEnv(existing, [], ['CACHE_URL'])).toEqual(existing);
  });

  it('never stores a value behind a reference', () => {
    const [entry] = mergeLinkEnv(
      [],
      [
        {
          name: 'DATABASE_URL',
          value: 'postgresql://u:p@h:5432/db',
          secret: true,
          externalSecretRef: ref,
        },
      ],
      ['DATABASE_URL'],
    );
    expect(entry.value).toBe('');
  });
});
