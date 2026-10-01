jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));
jest.mock('ip-cidr', () => ({}));

import { PostgresDumpService } from './logical-dump.service';
import { DumpFamily, dumpScript, loadScript } from './logical-dump.util';
import {
  RCLONE_CRYPT_CIPHER,
  deriveCryptPasswords,
} from '../utils/rclone-crypt.util';

const PASSPHRASE = 'destination-passphrase-for-tests';

function make(opts: { stored?: string[] } = {}) {
  const service = Object.create(
    PostgresDumpService.prototype,
  ) as PostgresDumpService;
  const applied: any[] = [];
  const r = service as any;
  r.logger = { log: jest.fn(), warn: jest.fn() };
  r.engine = 'postgres-dump';
  r.catalogSlug = 'postgresql';
  r.family = DumpFamily.POSTGRES;
  r.sizes = new Map();
  r.lastBackup = new Map();
  r.encryption = { decrypt: (v: string) => `plain-${v}` };
  r.appRepo = {
    findOne: async () => ({
      id: 'app-1',
      clusterId: 'cl-1',
      k8sNamespace: 'ns',
      slug: 'pg',
    }),
  };
  r.clusterRepo = { findOne: async () => ({ kubeconfigEncrypted: 'kc' }) };
  r.k8s = {
    listResourcesByLabel: async (_kc: string, kind: string) =>
      kind === 'Pod'
        ? [
            {
              status: { phase: 'Running', podIP: '10.0.0.1' },
              metadata: { name: 'pod-1' },
              spec: { containers: [{ name: 'pg', image: 'postgres:16' }] },
            },
          ]
        : [],
    applyManifest: jest.fn(async (_kc: string, m: string) => {
      applied.push(JSON.parse(m));
    }),
    getResource: async () => ({ status: { succeeded: 1 } }),
    getPodLogs: async () => 'FLUI_DUMP_BYTES=42',
    deleteResource: jest.fn(async () => undefined),
  };
  const dest = {
    id: 'dest-1',
    name: 'scaleway',
    bucket: 'b',
    pathPrefix: 'pre',
    endpoint: 'https://s3',
    region: 'fr-par',
    provider: 'generic_s3',
    accessKeyEncrypted: 'AK',
    secretKeyEncrypted: 'SK',
  };
  r.policyRepo = {
    findDbPolicyForApp: async () => ({
      destinations: [{ role: 'primary', destinationId: 'dest-1' }],
    }),
  };
  r.destRepo = { findById: async () => dest };
  r.destinations = {
    passphraseFor: jest.fn(async () => PASSPHRASE),
    decryptPassphrase: () => PASSPHRASE,
    toCredentials: () => ({ bucket: 'b', pathPrefix: 'pre' }),
  };
  r.storage = {
    forProvider: () => ({
      listObjects: async () => ({ keys: opts.stored ?? [], hasMore: false }),
    }),
  };
  r.retirement = { afterEncryptedDatabaseBackup: jest.fn(async () => ({})) };
  return { service, applied, dest };
}

const secretOf = (applied: any[]) =>
  applied.find((m) => m.kind === 'Secret').stringData;
const jobOf = (applied: any[]) => applied.find((m) => m.kind === 'Job');

describe('logical dumps through rclone crypt', () => {
  const keys = deriveCryptPasswords(PASSPHRASE);

  it('configures crypt in both scripts, with the borrowed rclone', () => {
    for (const script of [
      dumpScript(DumpFamily.POSTGRES),
      loadScript(DumpFamily.MARIADB),
    ]) {
      expect(script).toContain('RCLONE_CONFIG_FLUI_CRYPT_TYPE=crypt');
      expect(script).toContain('| /flui/rclone obscure -');
    }
  });

  it('writes a new dump through flui_crypt, keyed from the destination', async () => {
    const { service, applied } = make();

    const label = await service.baseBackup('app-1');

    const secret = secretOf(applied);
    expect(secret.FLUI_REMOTE).toBe(
      `flui_crypt:b/pre/dumps/app-1/${label}/dump.pgdump`,
    );
    expect(secret.FLUI_CRYPT_PASSWORD).toBe(keys.password);
    expect(secret.FLUI_CRYPT_PASSWORD2).toBe(keys.password2);

    const job = JSON.stringify(jobOf(applied));
    for (const literal of [
      keys.password,
      keys.password2,
      PASSPHRASE,
      'plain-SK',
    ]) {
      expect(job).not.toContain(literal);
    }
    expect(job).toContain('"secretRef"');

    const facts = await service.describeForArtifact('app-1');
    expect(facts.repository).toEqual({
      objectKeyPrefix: 'dumps/app-1/',
      cipher: RCLONE_CRYPT_CIPHER,
    });
  });

  it('loads an encrypted dump through flui_crypt', async () => {
    const { service, applied, dest } = make({
      stored: ['pre/dumps/app-src/L1/dump.pgdump.bin'],
    });

    await service.loadIntoRestored('app-1', {
      sourceAppId: 'app-src',
      engineRef: 'L1',
      destination: dest as never,
    });

    const secret = secretOf(applied);
    expect(secret.FLUI_REMOTE).toBe(
      'flui_crypt:b/pre/dumps/app-src/L1/dump.pgdump',
    );
    expect(secret.FLUI_CRYPT_PASSWORD).toBe(keys.password);
  });

  it('loads a dump taken before encryption as it is, with no key', async () => {
    const { service, applied, dest } = make({
      stored: ['pre/dumps/app-src/L0/dump.pgdump'],
    });

    await service.loadIntoRestored('app-1', {
      sourceAppId: 'app-src',
      engineRef: 'L0',
      destination: dest as never,
    });

    const secret = secretOf(applied);
    expect(secret.FLUI_REMOTE).toBe('flui:b/pre/dumps/app-src/L0/dump.pgdump');
    expect(secret.FLUI_CRYPT_PASSWORD).toBeUndefined();
  });

  it('refuses a dump that is no longer in the bucket', async () => {
    const { service, applied, dest } = make({ stored: [] });

    await expect(
      service.loadIntoRestored('app-1', {
        sourceAppId: 'app-src',
        engineRef: 'L0',
        destination: dest as never,
      }),
    ).rejects.toThrow(/no longer in the destination bucket/);
    expect(applied).toHaveLength(0);
  });

  it('names both spellings of a dump for retention to delete', () => {
    const { service } = make();
    expect(service.artifactObjectKeys('app-1', 'L1')).toEqual([
      'dumps/app-1/L1/dump.pgdump.bin',
      'dumps/app-1/L1/dump.pgdump',
    ]);
  });

  it('retires plaintext only after an encrypted dump', async () => {
    const { service } = make();
    const retirement = (service as any).retirement;

    await service.retirePlaintext('app-1', {
      id: 'a-plain',
      manifestSummary: { repository: { cipher: 'none' } },
    } as never);
    expect(retirement.afterEncryptedDatabaseBackup).not.toHaveBeenCalled();

    await service.retirePlaintext('app-1', {
      id: 'a-enc',
      manifestSummary: { repository: { cipher: RCLONE_CRYPT_CIPHER } },
    } as never);
    expect(retirement.afterEncryptedDatabaseBackup).toHaveBeenCalledWith({
      appId: 'app-1',
      engine: 'postgres-dump',
      enginePrefix: 'dumps/app-1/',
      destinationId: 'dest-1',
      encryptedArtifactId: 'a-enc',
    });
  });
});
