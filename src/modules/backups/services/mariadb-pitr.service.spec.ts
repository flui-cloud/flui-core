// The Kubernetes client ships ESM and this project's jest transforms only
// `jose`; every call it would make is stubbed here.
jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {},
  KubernetesObjectApi: { makeApiClient: () => ({}) },
  CoreV1Api: class {},
  Exec: class {},
  PatchStrategy: { MergePatch: 'application/merge-patch+json' },
}));

import { MariadbPitrService } from './mariadb-pitr.service';

/**
 * MariaDB is the first engine whose continuous backup needs a second process
 * to exist, and the refusals here are what keep that from being discovered
 * late.
 *
 * Postgres hands each finished segment to a command of its own, so enabling it
 * is a configuration change and nothing else has to be alive. MariaDB writes
 * its binary logs and forgets them: without a companion reading continuously,
 * turning the policy on stops the server purging its own logs and ships
 * nothing — a disk that fills behind a row that claims protection.
 */
describe('MariadbPitrService', () => {
  function withPods(pods: any[] | undefined, exec?: jest.Mock) {
    const service: MariadbPitrService = Object.create(
      MariadbPitrService.prototype,
    );
    (service as any).logger = { log: jest.fn(), warn: jest.fn() };
    (service as any).k8s = {
      listResourcesByLabel: jest.fn(async () => pods ?? []),
      execInPod: exec ?? jest.fn(async () => 'OK'),
    };
    (service as any).encryption = { decrypt: (v: string) => v };
    (service as any).appRepo = {
      findOne: jest.fn(async () => ({
        id: 'app-1',
        clusterId: 'cl-1',
        k8sNamespace: 'ns',
        slug: 'mariadb-abc',
        env: [
          { name: 'MARIADB_USER', value: 'srcuser' },
          { name: 'MARIADB_DATABASE', value: 'srcdb' },
        ],
      })),
    };
    (service as any).clusterRepo = {
      findOne: jest.fn(async () => ({ kubeconfigEncrypted: 'kc' })),
    };
    return service;
  }

  const pod = (containers: string[]) => ({
    spec: { containers: containers.map((name) => ({ name })) },
  });

  describe('requireTooling', () => {
    it('refuses when the pod carries no shipper, before touching the server', async () => {
      const exec = jest.fn(async () => 'OK');
      const service = withPods([pod(['mariadb-abc'])], exec);

      await expect(service.requireTooling('app-1')).rejects.toThrow(
        /no backup shipper alongside it/,
      );
      // Nothing was run in the database: `enable` flips
      // `binlog_expire_logs_seconds` to 0, and doing that for a policy that is
      // then refused leaves a server that never purges its own logs again.
      expect(exec).not.toHaveBeenCalled();
    });

    it('does not refuse merely because no pod could be listed', async () => {
      // `listResourcesByLabel` answers `[]` for an unreachable cluster as well
      // as for a database that is stopped. Reading the first as "no shipper"
      // would refuse a perfectly equipped database over a network blip, and
      // point its owner at the wrong fix.
      const exec = jest.fn(async () => {
        throw new Error('No running pod found with selector ...');
      });
      const service = withPods([], exec);

      await expect(service.requireTooling('app-1')).rejects.toThrow(
        /is not running/,
      );
    });

    it('passes the shipper check when the container is there', async () => {
      const exec = jest
        .fn()
        .mockResolvedValueOnce('OK') // the three binaries
        .mockResolvedValueOnce('1'); // @@log_bin
      const service = withPods(
        [pod(['mariadb-abc', 'flui-binlog-shipper'])],
        exec,
      );

      await expect(service.requireTooling('app-1')).resolves.toBeUndefined();
    });
  });

  describe('buildRestoreEnv', () => {
    const dest = {
      endpoint: 'https://s3.example.com',
      bucket: 'backups',
      region: 'eu-central-1',
      pathPrefix: '/flui/',
      accessKeyEncrypted: 'AKIA',
      secretKeyEncrypted: 'SECRET',
      forcePathStyle: true,
    } as any;

    it('names everything with the engine prefix so it can all be stripped', async () => {
      // These values are a live credential for the SOURCE's repository and are
      // needed for one boot only. A name outside the prefix would survive the
      // strip step and outlive the restore that needed it.
      const service = withPods([]);
      const env = service.buildRestoreEnv('app-1', dest);

      expect(Object.keys(env).every((k) => k.startsWith('FLUI_MARIADB_'))).toBe(
        true,
      );
      expect(env.FLUI_MARIADB_RESTORE).toBe('1');
    });

    it('puts base and logs under one per-application prefix', async () => {
      const service = withPods([]);
      const env = service.buildRestoreEnv('app-1', dest);

      expect(env.FLUI_MARIADB_S3_PATH).toBe('flui/mariadb/app-1/');
    });

    it('prefers an instant over a base label, and never sends both', async () => {
      const service = withPods([]);
      const at = new Date('2026-09-05T06:31:33.000Z');

      const timed = service.buildRestoreEnv('app-1', dest, at, 'base-xyz');
      expect(timed.FLUI_MARIADB_TARGET_TIME).toBe('2026-09-05 06:31:33');
      expect(timed.FLUI_MARIADB_BASE_LABEL).toBeUndefined();

      const labelled = service.buildRestoreEnv('app-1', dest, null, 'base-xyz');
      expect(labelled.FLUI_MARIADB_BASE_LABEL).toBe('base-xyz');
      expect(labelled.FLUI_MARIADB_TARGET_TIME).toBeUndefined();
    });

    it('sends the instant without a zone suffix, in UTC', async () => {
      // `--stop-datetime` takes no suffix and is read in the server's own
      // zone. Anything but a UTC value against a UTC container shifts the
      // moment being recovered to, silently.
      const service = withPods([]);
      const env = service.buildRestoreEnv(
        'app-1',
        dest,
        new Date('2026-09-05T06:31:33.456Z'),
      );

      expect(env.FLUI_MARIADB_TARGET_TIME).toBe('2026-09-05 06:31:33');
    });
  });

  describe('repository generation', () => {
    // The failure it prevents is silent in every direction. A MariaDB restored
    // onto a fresh volume numbers its binary logs from `binlog.000001` again —
    // the base carries no `binlog.index` — so shipping into the prefix its
    // previous life used writes names the repository already holds, with
    // different contents behind them. The upload rule ships nothing while the
    // new files are shorter, then overwrites; the contiguity check sees an
    // unbroken run of names; and the purge floor, read from the old bases,
    // names a log the new server does not have.
    it('separates one life of a data directory from the next', () => {
      const service = withPods([]);

      expect(service.artifactObjectPrefix('app-1', 'g20260905T120000')).toBe(
        'mariadb/app-1/g20260905T120000/',
      );
      expect(service.artifactObjectKeys('app-1', 'base-x', 'g1')).toEqual([
        'mariadb/app-1/g1/base/base-x/binlog_info',
        'mariadb/app-1/g1/base/base-x/base.mbstream',
      ]);
    });

    it('leaves rows written before generations existed where they are', () => {
      // Their objects are in the flat layout, and that is the only reading
      // that finds them.
      const service = withPods([]);

      expect(service.artifactObjectPrefix('app-1')).toBe('mariadb/app-1/');
      expect(service.artifactObjectKeys('app-1', 'base-x')).toEqual([
        'mariadb/app-1/base/base-x/binlog_info',
        'mariadb/app-1/base/base-x/base.mbstream',
      ]);
    });

    it('restores from the generation the artifact was written into', () => {
      const service = withPods([]);
      const env = service.buildRestoreEnv(
        'app-1',
        {
          endpoint: 'https://s3.example.com',
          bucket: 'b',
          region: 'r',
          pathPrefix: '/flui/',
          accessKeyEncrypted: 'k',
          secretKeyEncrypted: 's',
          forcePathStyle: true,
        } as any,
        null,
        'base-x',
        'g1',
      );

      expect(env.FLUI_MARIADB_S3_PATH).toBe('flui/mariadb/app-1/g1/');
    });

    it('mints something ordered, so a bucket listing reads chronologically', () => {
      const service = withPods([]);
      const a = service.mintGeneration();

      expect(a).toMatch(/^g\d{8}\d{6}$/);
    });
  });

  it('spells identities the way the MariaDB image expects to receive them', async () => {
    const service = withPods([]);

    expect(service.identityEnv({ user: 'srcuser', database: 'srcdb' })).toEqual(
      { MARIADB_USER: 'srcuser', MARIADB_DATABASE: 'srcdb' },
    );
  });
});
