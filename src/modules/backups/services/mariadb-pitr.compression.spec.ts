jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {},
  KubernetesObjectApi: { makeApiClient: () => ({}) },
  CoreV1Api: class {},
  Exec: class {},
  PatchStrategy: { MergePatch: 'application/merge-patch+json' },
}));

import { MariadbPitrService } from './mariadb-pitr.service';
import { artifactObjectKeys, renderShipperConfig } from './mariadb-pitr.util';

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

interface Replies {
  features: string;
  config?: string;
  base?: string;
  bases?: string;
  edge?: string;
}

function make(replies: Replies) {
  const service = Object.create(
    MariadbPitrService.prototype,
  ) as MariadbPitrService;
  const r = service as any;
  const applied: string[] = [];
  const scripts: string[] = [];
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
      if (
        script.includes('shipper-features') &&
        script.includes('FLUI_FEATURES_READ')
      ) {
        return `${replies.features}\nFLUI_FEATURES_READ`;
      }
      if (script.includes('FLUI_CONFIG_ABSENT')) return replies.config ?? '';
      if (script.includes('mariadb-backup --backup')) return replies.base ?? '';
      if (script.includes('BASES=')) return replies.bases ?? '';
      if (script.includes('SHIPPED=')) return replies.edge ?? '';
      if (script.includes('command -v')) return 'OK';
      if (script.includes('@@log_bin')) return '1';
      return '';
    }),
  };
  r.destinations = {
    passphraseFor: jest.fn(async () => 'passphrase'),
    decryptPassphrase: () => 'passphrase',
  };
  r.retirement = { afterEncryptedDatabaseBackup: jest.fn(async () => ({})) };
  return { service, applied, scripts };
}

const shipperConfig = (applied: string[]) => {
  const secret = applied.find((m) => m.includes('kind: Secret')) ?? '';
  const data = /config: (\S+)/.exec(secret)?.[1] ?? '';
  return Buffer.from(data, 'base64').toString('utf-8');
};

const at = (msAgo: number) =>
  new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace('T', ' ');

const DAY = 86_400_000;

describe('MariaDB backups compressed with zstd', () => {
  it('asks a shipper that can compress to do so, and one that cannot to carry on as before', async () => {
    const able = make({ features: 'rclone-crypt\nzstd' });
    await able.service.enable('app-1', dest);
    expect(shipperConfig(able.applied)).toContain(
      'export FLUI_COMPRESSION="zstd"',
    );

    const old = make({ features: 'rclone-crypt' });
    await old.service.enable('app-1', dest);
    expect(shipperConfig(old.applied)).not.toContain('FLUI_COMPRESSION');
  });

  it('renders the compression setting only when asked', () => {
    const base = {
      appId: 'app-1',
      dest: dest as any,
      repositoryPrefix: 'mariadb/app-1/g1/',
      accessKey: 'ak',
      secretKey: 'sk',
    };
    expect(renderShipperConfig(base)).not.toContain('FLUI_COMPRESSION');
    expect(renderShipperConfig({ ...base, compression: 'zstd' })).toContain(
      'export FLUI_COMPRESSION="zstd"',
    );
  });

  it('streams the base through zstd only when the image and the configuration both allow it', async () => {
    const { service, scripts } = make({
      features: 'zstd',
      config: 'FLUI_CONFIG_PLAIN\nFLUI_CONFIG_ZSTD',
      base: 'FLUI_BASE_OK=base-x POS=binlog.000002:42 CIPHER=none COMPRESSION=zstd LOGS=zstd',
    });
    await service.enable('app-1', dest);
    await service.baseBackup('app-1');

    const script = scripts.find((s) => s.includes('mariadb-backup --backup'))!;
    expect(script).toContain(
      'if [ "${FLUI_COMPRESSION:-}" = "zstd" ] && command -v zstd',
    );
    expect(script).toMatch(
      /zstd -q -3 -T2 -c \| rclone rcat "\$DEST\/base\.mbstream\.zst"/,
    );
    expect(script).toContain('rclone rcat "$DEST/base.mbstream" ');
    expect(script).toContain('COMPRESSION=$COMP');

    const facts = await service.describeForArtifact('app-1');
    expect(facts.compression).toEqual({
      type: 'zstd',
      level: 3,
      logs: 'zstd',
    });
  });

  it('records no compression for a base the shipper reports as uncompressed', async () => {
    const { service } = make({
      features: 'rclone-crypt',
      config: 'FLUI_CONFIG_CRYPT\nFLUI_CONFIG_RAW',
      base: 'FLUI_BASE_OK=base-x POS=binlog.000002:42 CIPHER=none',
    });
    await service.enable('app-1', dest);
    await service.baseBackup('app-1');

    const facts = await service.describeForArtifact('app-1');
    expect(facts.compression).toEqual({ type: 'none', logs: 'none' });
  });

  it('deletes a compressed base and a legacy one alike, position file first', () => {
    expect(artifactObjectKeys('app-1', 'base-x', 'g1')).toEqual([
      'mariadb/app-1/g1/base/base-x/binlog_info.bin',
      'mariadb/app-1/g1/base/base-x/binlog_info',
      'mariadb/app-1/g1/base/base-x/base.mbstream.zst.bin',
      'mariadb/app-1/g1/base/base-x/base.mbstream.zst',
      'mariadb/app-1/g1/base/base-x/base.mbstream.bin',
      'mariadb/app-1/g1/base/base-x/base.mbstream',
    ]);
  });
});

describe('MariaDB base cadence', () => {
  const current = 'FLUI_CONFIG_PLAIN\nFLUI_CONFIG_ZSTD';
  const bases = (msAgo: number) =>
    `BASES=${at(msAgo)};base-a/binlog_info \nLOGS=${at(60_000)};binlog.000009.zst `;

  async function ready(replies: Omit<Replies, 'features'>) {
    const made = make({ features: 'zstd', ...replies });
    await made.service.enable('app-1', dest);
    return made;
  }

  it('lets the base wait while the last one is recent and the logs are shipping', async () => {
    const { service } = await ready({
      config: current,
      bases: bases(2 * DAY),
      edge: 'SERVER=binlog.000010\nSHIPPED=binlog.000009',
    });
    const notDue = await service.baseNotDue('app-1', 7);
    expect(notDue).not.toBeNull();
    expect(Date.parse(notDue!.dueAt) - Date.parse(notDue!.lastBaseAt)).toBe(
      7 * DAY,
    );
  });

  it('takes a base once the last one is older than the cadence', async () => {
    const { service } = await ready({
      config: current,
      bases: bases(8 * DAY),
      edge: 'SERVER=binlog.000010\nSHIPPED=binlog.000010',
    });
    expect(await service.baseNotDue('app-1', 7)).toBeNull();
  });

  it('takes a base when the repository has none', async () => {
    const { service } = await ready({
      config: current,
      bases: 'BASES=\nLOGS=',
      edge: 'SERVER=binlog.000010\nSHIPPED=binlog.000010',
    });
    expect(await service.baseNotDue('app-1', 7)).toBeNull();
  });

  it('takes a base when the logs trail the server, rather than trust them', async () => {
    const { service } = await ready({
      config: current,
      bases: bases(DAY),
      edge: 'SERVER=binlog.000020\nSHIPPED=binlog.000009',
    });
    expect(await service.baseNotDue('app-1', 7)).toBeNull();
  });

  it('takes a base while the shipper still reads the previous configuration', async () => {
    // A new cipher or a new generation is a repository with no base in it,
    // and listing through the old configuration would find the old ones.
    const { service } = await ready({
      config: 'FLUI_CONFIG_PLAIN\nFLUI_CONFIG_RAW',
      bases: bases(DAY),
      edge: 'SERVER=binlog.000010\nSHIPPED=binlog.000010',
    });
    expect(await service.baseNotDue('app-1', 7)).toBeNull();
  });

  it('takes a base when this process has not configured shipping', async () => {
    const { service } = make({ features: 'zstd', config: current });
    expect(await service.baseNotDue('app-1', 7)).toBeNull();
  });
});
