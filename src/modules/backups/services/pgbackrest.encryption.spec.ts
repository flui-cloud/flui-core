jest.mock('@kubernetes/client-node', () => ({}));

import { PgBackrestService } from './pgbackrest.service';
import { assertLiveRepository } from './pgbackrest-repo.util';

const APP = 'app-1';
const dest = {
  id: 'dest-1',
  endpoint: 'https://s3.example.test',
  bucket: 'bkt',
  region: 'eu',
  pathPrefix: 'pfx/',
  forcePathStyle: true,
  accessKeyEncrypted: 'AK',
  secretKeyEncrypted: 'SK',
} as any;

function scriptOf(cmd: string[]): string {
  const b64 = /echo (\S+) \| base64 -d \| sh/.exec(cmd[2])![1];
  return Buffer.from(b64, 'base64').toString('utf-8');
}

function make(
  opts: {
    execReply?: (script: string) => string;
    passphrase?: string;
  } = {},
) {
  const scripts: string[] = [];
  const k8s = {
    execInPod: jest.fn(async (...args: any[]) => {
      const script = scriptOf(args[4]);
      scripts.push(script);
      return opts.execReply?.(script) ?? 'yes';
    }),
  };
  const destinations = {
    passphraseFor: jest.fn(async () => 'from-passphrase-for'),
    decryptPassphrase: jest.fn(() =>
      'passphrase' in opts ? opts.passphrase : 'stored-passphrase',
    ),
  };
  const service = new PgBackrestService(
    k8s as any,
    { decrypt: (v: string) => v } as any,
    {
      findOne: jest.fn(async () => ({
        id: APP,
        clusterId: 'c1',
        k8sNamespace: 'ns',
        slug: 'pg',
        env: [],
      })),
    } as any,
    {
      findOne: jest.fn(async () => ({ kubeconfigEncrypted: 'kc' })),
    } as any,
    destinations as any,
    { retire: jest.fn() } as any,
  );
  return { service, scripts, destinations };
}

describe('pgBackRest repository encryption', () => {
  it('ships to a new encrypted repository keyed with the destination passphrase', async () => {
    const { service, scripts, destinations } = make();

    await service.enable(APP, dest);

    expect(destinations.passphraseFor).toHaveBeenCalledWith(dest);
    const enableScript = scripts.find((s) => s.includes('stanza-create'))!;
    const confB64 = /echo (\S+) \| base64 -d >/.exec(enableScript)![1];
    const conf = Buffer.from(confB64, 'base64').toString('utf-8');
    expect(conf).toContain('repo1-path=/pfx/pgbackrest/app-1/encrypted\n');
    expect(conf).toContain('repo1-cipher-type=aes-256-cbc\n');
    expect(conf).toContain('repo1-cipher-pass=from-passphrase-for\n');
  });

  it('records new artifacts under the encrypted repository', () => {
    expect(make().service.artifactObjectPrefix(APP)).toBe(
      'pgbackrest/app-1/encrypted/',
    );
  });

  it('refuses a passphrase that would add lines to the configuration', async () => {
    const { service, destinations } = make();
    destinations.passphraseFor.mockResolvedValueOnce('a\nrepo1-path=/x');
    await expect(service.enable(APP, dest)).rejects.toThrow(/line break/);
  });

  describe('what an artifact claims', () => {
    const reply = (cipher: string) => (script: string) =>
      script.includes('info --output=json')
        ? JSON.stringify([{ name: 'main', cipher, backup: [] }])
        : '17.2';

    it('the cipher the repository reports', async () => {
      const facts = await make({
        execReply: reply('aes-256-cbc'),
      }).service.describeForArtifact(APP);
      expect(facts.repository).toEqual({
        objectKeyPrefix: 'pgbackrest/app-1/encrypted/',
        cipher: 'aes-256-cbc',
      });
    });

    it('no encryption when the repository says none, whatever was configured', async () => {
      const facts = await make({
        execReply: reply('none'),
      }).service.describeForArtifact(APP);
      expect(facts.repository?.cipher).toBe('none');
    });
  });

  describe('restore environment', () => {
    it('a plaintext artifact from before encryption: old path, no key', () => {
      const { service, destinations } = make();
      const env = service.buildRestoreEnv(
        APP,
        dest,
        undefined,
        undefined,
        undefined,
        {
          applicationId: APP,
        },
      );
      expect(env.FLUI_PG_S3_PATH).toBe('/pfx/pgbackrest/app-1');
      expect(env).not.toHaveProperty('FLUI_PG_CIPHER_PASS');
      expect(destinations.decryptPassphrase).not.toHaveBeenCalled();
    });

    it('an encrypted artifact: its repository and the key it was written with', () => {
      const { service, destinations } = make();
      const env = service.buildRestoreEnv(
        APP,
        dest,
        undefined,
        'set-1',
        undefined,
        {
          repository: {
            objectKeyPrefix: 'pgbackrest/app-1/encrypted/',
            cipher: 'aes-256-cbc',
          },
        },
      );
      expect(env.FLUI_PG_S3_PATH).toBe('/pfx/pgbackrest/app-1/encrypted');
      expect(env.FLUI_PG_CIPHER_PASS).toBe('stored-passphrase');
      expect(env.FLUI_PG_RESTORE_SET).toBe('set-1');
      expect(destinations.passphraseFor).not.toHaveBeenCalled();
    });

    it('an encrypted artifact whose destination lost its passphrase is refused, not given a new one', () => {
      const { service, destinations } = make({ passphrase: undefined });
      expect(() =>
        service.buildRestoreEnv(APP, dest, undefined, undefined, undefined, {
          repository: {
            objectKeyPrefix: 'pgbackrest/app-1/encrypted/',
            cipher: 'aes-256-cbc',
          },
        }),
      ).toThrow(/no longer holds the passphrase/);
      expect(destinations.passphraseFor).not.toHaveBeenCalled();
    });
  });

  describe('live validation answers only for the artifact’s own repository', () => {
    const encrypted = {
      repository: {
        objectKeyPrefix: 'pgbackrest/app-1/encrypted/',
        cipher: 'aes-256-cbc',
      },
    };
    const live = (path: string) =>
      `[]\nFLUI_REPO_PATH=${path}\nFLUI_LAST_ARCHIVED=\n`;

    it('matches', () => {
      expect(() =>
        assertLiveRepository(
          APP,
          encrypted,
          live('/pfx/pgbackrest/app-1/encrypted'),
        ),
      ).not.toThrow();
      expect(() =>
        assertLiveRepository(APP, {}, live('/pfx/pgbackrest/app-1')),
      ).not.toThrow();
    });

    it('a plaintext artifact while the database already ships to the encrypted repository', () => {
      expect(() =>
        assertLiveRepository(APP, {}, live('/pfx/pgbackrest/app-1/encrypted')),
      ).toThrow(/not to the repository this backup was written to/);
    });

    it('info() passes the refusal on so the restore proceeds against the bucket', async () => {
      const { service } = make({
        execReply: () => live('/pfx/pgbackrest/app-1/encrypted'),
      });
      await expect(service.info(APP, {})).rejects.toThrow(
        /not to the repository/,
      );
      await expect(service.info(APP)).resolves.toMatchObject({
        backupCount: 0,
      });
    });
  });
});
