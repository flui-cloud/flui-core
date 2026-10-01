jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {},
  KubernetesObjectApi: { makeApiClient: () => ({}) },
  CoreV1Api: class {},
  Exec: class {},
  PatchStrategy: { MergePatch: 'application/merge-patch+json' },
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { MariadbPitrService } from './mariadb-pitr.service';
import { renderShipperConfig } from './mariadb-pitr.util';
import {
  RCLONE_CRYPT_CIPHER,
  deriveCryptPasswords,
} from '../utils/rclone-crypt.util';

const PASSPHRASE = 'destination-passphrase-for-tests';
const dest = {
  id: 'dest-1',
  name: 'scaleway',
  bucket: 'b',
  pathPrefix: 'pre',
  endpoint: 'https://s3',
  region: 'fr-par',
  forcePathStyle: true,
  accessKeyEncrypted: 'AK',
  secretKeyEncrypted: 'SK',
} as never;

function make(opts: { features: string; baseCipher?: string }) {
  const service = Object.create(
    MariadbPitrService.prototype,
  ) as MariadbPitrService;
  const r = service as any;
  const applied: string[] = [];
  r.logger = { log: jest.fn(), warn: jest.fn() };
  r.shipping = new Map();
  r.engine = 'mariadb';
  r.encryption = { decrypt: (v: string) => `plain-${v}` };
  r.appRepo = {
    findOne: async () => ({
      id: 'app-1',
      clusterId: 'cl-1',
      k8sNamespace: 'ns',
      slug: 'maria',
      env: [],
    }),
  };
  r.clusterRepo = { findOne: async () => ({ kubeconfigEncrypted: 'kc' }) };
  const scripts: string[] = [];
  r.k8s = {
    listResourcesByLabel: async () => [
      {
        spec: {
          containers: [{ name: 'maria' }, { name: 'flui-binlog-shipper' }],
        },
      },
    ],
    applyManifest: jest.fn(async (_kc: string, m: string) => {
      applied.push(m);
    }),
    execInPod: jest.fn(async (...args: any[]) => {
      const cmd: string[] = args[4];
      const script = Buffer.from(
        /echo (\S+) \| base64/.exec(cmd[2])?.[1] ?? '',
        'base64',
      ).toString('utf-8');
      scripts.push(script);
      if (script.includes('shipper-features')) {
        return `${opts.features}\nFLUI_FEATURES_READ`;
      }
      if (script.includes('FLUI_CONFIG_CRYPT')) {
        return opts.baseCipher === RCLONE_CRYPT_CIPHER
          ? 'FLUI_CONFIG_CRYPT'
          : 'FLUI_CONFIG_PLAIN';
      }
      if (script.includes('mariadb-backup --backup')) {
        return `FLUI_BASE_OK=base-x POS=binlog.000002:42 CIPHER=${opts.baseCipher ?? 'none'}`;
      }
      if (script.includes('command -v')) return 'OK';
      if (script.includes('@@log_bin')) return '1';
      return '';
    }),
  };
  r.destinations = {
    passphraseFor: jest.fn(async () => PASSPHRASE),
    decryptPassphrase: () => PASSPHRASE,
  };
  r.retirement = { afterEncryptedDatabaseBackup: jest.fn(async () => ({})) };
  return { service, applied, scripts };
}

const shipperConfig = (applied: string[]) => {
  const secret = applied.find((m) => m.includes('kind: Secret')) ?? '';
  const data = /config: (\S+)/.exec(secret)?.[1] ?? '';
  return { secret, config: Buffer.from(data, 'base64').toString('utf-8') };
};

describe('MariaDB continuous backup through rclone crypt', () => {
  const keys = deriveCryptPasswords(PASSPHRASE);

  it('renders a crypt repository only when given the keys', () => {
    const base = {
      appId: 'app-1',
      dest: dest as any,
      repositoryPrefix: 'mariadb/app-1/g1/',
      accessKey: 'ak',
      secretKey: 'sk',
    };
    const plain = renderShipperConfig(base);
    expect(plain).toContain('FLUI_S3_REMOTE="flui:b/pre/mariadb/app-1/g1"');
    expect(plain).not.toContain('FLUI_ENCRYPTION');

    const crypt = renderShipperConfig({ ...base, crypt: keys });
    expect(crypt).toContain(
      'FLUI_S3_REMOTE="flui_crypt:b/pre/mariadb/app-1/g1"',
    );
    expect(crypt).toContain(`export FLUI_ENCRYPTION="${RCLONE_CRYPT_CIPHER}"`);
    expect(crypt).toContain(`export FLUI_CRYPT_PASSWORD="${keys.password}"`);
    expect(crypt).toContain(`export FLUI_CRYPT_PASSWORD2="${keys.password2}"`);
  });

  it('hands a shipper that supports it an encrypted repository, in its Secret', async () => {
    const { service, applied } = make({ features: 'rclone-crypt' });

    await service.enable('app-1', dest, { generation: 'g1' });

    const { secret, config } = shipperConfig(applied);
    expect(config).toContain('flui_crypt:b/pre/mariadb/app-1/g1');
    expect(config).toContain(keys.password);
    expect(secret).not.toContain(keys.password);
  });

  it('keeps an old shipper on plaintext rather than give it a remote it cannot open', async () => {
    const { service, applied } = make({ features: '' });

    await service.enable('app-1', dest, { generation: 'g1' });

    const { config } = shipperConfig(applied);
    expect(config).toContain('flui:b/pre/mariadb/app-1/g1');
    expect(config).not.toContain('FLUI_CRYPT_PASSWORD');
    expect((service as any).logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/predates encryption/),
    );
  });

  it('records the cipher the base reported, and configures crypt for it', async () => {
    const { service, scripts } = make({
      features: 'rclone-crypt',
      baseCipher: RCLONE_CRYPT_CIPHER,
    });
    await service.enable('app-1', dest, { generation: 'g1' });

    await service.baseBackup('app-1');

    const base = scripts.find((s) => s.includes('mariadb-backup --backup'));
    expect(base).toContain('RCLONE_CONFIG_FLUI_CRYPT_TYPE=crypt');
    expect(base).not.toContain(keys.password);
    const facts = await service.describeForArtifact('app-1');
    expect(facts.repository).toEqual({
      objectKeyPrefix: 'mariadb/app-1/g1/',
      cipher: RCLONE_CRYPT_CIPHER,
    });
  });

  it('never claims encryption the base did not report', async () => {
    const { service } = make({ features: '', baseCipher: 'none' });
    await service.enable('app-1', dest, { generation: 'g1' });

    await service.baseBackup('app-1');

    const facts = await service.describeForArtifact('app-1');
    expect(facts.repository?.cipher).toBe('none');
  });

  it('restores an encrypted artifact with its derived keys, a legacy one without', () => {
    const { service } = make({ features: '' });

    const encrypted = service.buildRestoreEnv(
      'app-1',
      dest,
      null,
      'base-x',
      'g1',
      { repository: { cipher: RCLONE_CRYPT_CIPHER } },
    );
    expect(encrypted.FLUI_MARIADB_CRYPT_PASSWORD).toBe(keys.password);
    expect(encrypted.FLUI_MARIADB_CRYPT_PASSWORD2).toBe(keys.password2);
    expect(
      Object.keys(encrypted).every((k) => k.startsWith('FLUI_MARIADB_')),
    ).toBe(true);

    const legacy = service.buildRestoreEnv('app-1', dest, null, 'base-x');
    expect(legacy.FLUI_MARIADB_CRYPT_PASSWORD).toBeUndefined();
  });

  it('is declared by the catalog, as secrets, so the installer keeps it', () => {
    const seed = load(
      readFileSync(
        join(__dirname, '../../catalog/seed/mariadb.flui.yaml'),
        'utf-8',
      ),
    ) as { spec: { env: Array<{ name: string; secret?: boolean }> } };
    for (const name of [
      'FLUI_MARIADB_CRYPT_PASSWORD',
      'FLUI_MARIADB_CRYPT_PASSWORD2',
    ]) {
      expect(seed.spec.env.find((e) => e.name === name)?.secret).toBe(true);
    }
  });

  it('retires plaintext through the engine hook, only after an encrypted base', async () => {
    const { service } = make({ features: 'rclone-crypt' });
    await service.enable('app-1', dest, { generation: 'g1' });
    const retirement = (service as any).retirement;

    await service.retirePlaintext('app-1', {
      id: 'a0',
      manifestSummary: { repository: { cipher: 'none' } },
    } as never);
    expect(retirement.afterEncryptedDatabaseBackup).not.toHaveBeenCalled();

    await service.retirePlaintext('app-1', {
      id: 'a1',
      manifestSummary: { repository: { cipher: RCLONE_CRYPT_CIPHER } },
    } as never);
    expect(retirement.afterEncryptedDatabaseBackup).toHaveBeenCalledWith({
      appId: 'app-1',
      engine: 'mariadb',
      enginePrefix: 'mariadb/app-1/',
      destinationId: 'dest-1',
      encryptedArtifactId: 'a1',
    });
  });
});
