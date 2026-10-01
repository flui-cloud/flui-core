jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));
jest.mock('ip-cidr', () => ({}));

import { VolumeBackupsService } from './volume-backups.service';
import { VolumeKopiaSnapshotService } from './volume-kopia-snapshot.service';
import { VolumeBackupDestinationService } from './volume-backup-destination.service';
import {
  KOPIA_CIPHER,
  deriveKopiaPassword,
} from '../../backups/utils/kopia-repository.util';

const PASSPHRASE = 'destination-passphrase-for-tests';

function make() {
  const service = Object.create(
    VolumeBackupsService.prototype,
  ) as VolumeBackupsService;
  const r = service as any;
  const exports: any[] = [];
  const recorded: any[] = [];
  r.logger = { log: jest.fn(), warn: jest.fn() };
  r.applicationsRepository = {
    findById: async () => ({
      id: 'app-1',
      slug: 'web',
      clusterId: 'cl-1',
      k8sNamespace: 'ns',
    }),
  };
  r.clusterRepository = {
    findOne: async () => ({
      id: 'cl-1',
      provider: 'hetzner',
      kubeconfigEncrypted: 'kc',
    }),
  };
  r.encryptionService = { decrypt: (v: string) => `plain-${v}` };
  r.volumeExportFactory = {
    getOrFail: () => ({
      capabilities: {},
      createExport: jest.fn(async (input: any) => {
        exports.push(input);
        return {
          exportId: input.keyPrefix,
          namespace: 'ns',
          sourceSizeGb: 1,
          actualBytes: 10,
          encrypted: !!input.encryption,
          createdAt: 'now',
          ready: true,
        };
      }),
    }),
  };
  r.appResourcesRepository = { findByApplicationId: async () => [] };
  r.volumeClaims = {
    resolveForApplication: async () => [{ name: 'data-web' }],
  };
  r.preflight = {
    check: async () => ({ facts: { quiesce: 'none' }, paused: [] }),
  };
  r.pauseLease = { release: async () => undefined };
  r.runner = {
    run: async (_meta: unknown, fn: () => Promise<unknown>) => ({
      result: await fn(),
      operationId: 'op-1',
    }),
  };
  r.copyLedger = {
    record: jest.fn(async (copy: any) => {
      recorded.push(copy);
      return { id: 'art-new' };
    }),
    lastKopiaVerification: jest.fn(async () => new Date()),
    followKopiaRetention: jest.fn(async () => []),
  };
  const snapshots: any[] = [];
  r.kopia = {
    sourceVolume: async () => ({ sizeGb: 5, nodeName: 'node-a' }),
    snapshot: jest.fn(async (args: any) => {
      snapshots.push(args);
      return {
        primary: {
          id: 'aaaabbbbccccdddd0000111122223333',
          source: {
            userName: 'flui',
            host: 'flui-app-1',
            path: '/flui/volumes/data-web',
          },
          rootEntry: { obj: 'kf00', summ: { size: 4096, files: 3 } },
        },
        bytesBefore: 100,
        bytesAfter: 1100,
        seconds: 4,
        maintenance: 'quick',
        created: true,
        listed: [{ id: 'aaaabbbbccccdddd0000111122223333' }],
        sqliteListed: [],
      };
    }),
  };
  r.destinationRepository = {
    findOne: async () => ({
      id: 'dest-1',
      bucket: 'b',
      endpoint: 'https://s3',
      region: 'fr-par',
      pathPrefix: 'pre',
      accessKeyEncrypted: 'AK',
      secretKeyEncrypted: 'SK',
      encryptionMode: 'flui_managed',
    }),
  };
  r.destinations = { passphraseFor: jest.fn(async () => PASSPHRASE) };
  r.retirement = { afterEncryptedVolumeCopy: jest.fn(async () => ({})) };
  r.destinationResolver = Object.assign(
    Object.create(VolumeBackupDestinationService.prototype),
    r,
  );
  r.kopiaSnapshots = Object.assign(
    Object.create(VolumeKopiaSnapshotService.prototype),
    r,
  );
  return { service, exports, recorded, snapshots };
}

describe('volume copies to a registered destination are kopia snapshots', () => {
  it('keys the repository from the destination passphrase, records it, then retires plaintext', async () => {
    const { service, exports, recorded, snapshots } = make();

    const res = await service.createForApp({
      applicationId: 'app-1',
      destinationId: 'dest-1',
    });

    expect(exports).toHaveLength(0);
    expect(snapshots[0].credentials).toEqual({
      password: deriveKopiaPassword(PASSPHRASE, 'app-1'),
      accessKeyId: 'plain-AK',
      secretAccessKey: 'plain-SK',
    });
    expect(snapshots[0].job).toMatchObject({
      appId: 'app-1',
      volumeName: 'data-web',
      pin: true,
      applyRetention: false,
      trigger: 'manual',
      sqlite: false,
      verify: false,
      nodeName: 'node-a',
      location: {
        bucket: 'b',
        endpoint: 's3',
        disableTls: false,
        prefix: 'pre/kopia/app-1/',
      },
    });
    expect(recorded[0]).toMatchObject({
      sink: 'kopia',
      exportId: 'aaaabbbbccccdddd0000111122223333',
      objectKeyPrefix: 'kopia/app-1/',
      destinationId: 'dest-1',
      sizeBytes: 4096,
      sourceSizeGb: 5,
      encryption: { cipher: KOPIA_CIPHER, mode: 'flui_managed' },
      kopia: {
        snapshotId: 'aaaabbbbccccdddd0000111122223333',
        rootObject: 'kf00',
        uploadedBytes: 1000,
        repositoryBytes: 1100,
        compression: 'zstd-fastest',
        splitter: 'DYNAMIC-1M-BUZHASH',
        pinned: true,
        maintenance: 'quick',
      },
    });
    expect(
      (service as any).copyLedger.followKopiaRetention,
    ).toHaveBeenCalledWith({
      applicationId: 'app-1',
      volumeName: 'data-web',
      destinationId: 'dest-1',
      listed: [{ id: 'aaaabbbbccccdddd0000111122223333' }],
    });
    expect(
      (service as any).retirement.afterEncryptedVolumeCopy,
    ).toHaveBeenCalledWith({
      appId: 'app-1',
      volumeName: 'data-web',
      encryptedArtifactId: 'art-new',
    });
    expect(res).toMatchObject({
      encrypted: true,
      engine: 'kopia',
      artifactId: 'art-new',
      uploadedBytes: 1000,
    });
    expect(JSON.stringify(res)).not.toContain(PASSPHRASE);
    expect(JSON.stringify(res)).not.toContain(
      deriveKopiaPassword(PASSPHRASE, 'app-1'),
    );
  });

  it('follows the policy on a scheduled run: its retention, unpinned, on the run job', async () => {
    const { service, recorded, snapshots } = make();
    const retention = {
      keepLatest: 1,
      keepHourly: 0,
      keepDaily: 7,
      keepWeekly: 4,
      keepMonthly: 3,
      keepAnnual: 0,
    };

    await service.createForApp({
      applicationId: 'app-1',
      destinationId: 'dest-1',
      policyId: 'pol-1',
      backupJobId: 'job-run',
      retention,
      expiresAt: new Date('2030-01-01'),
    });

    expect(snapshots[0].job).toMatchObject({
      pin: false,
      applyRetention: true,
      retention,
      trigger: 'scheduled',
    });
    expect(recorded[0]).toMatchObject({
      policyId: 'pol-1',
      backupJobId: 'job-run',
      kopia: { pinned: false },
    });
  });

  it('leaves a copy to a bucket passed by hand unencrypted, and retires nothing', async () => {
    const { service, exports, recorded } = make();

    const res = await service.createForApp({
      applicationId: 'app-1',
      destination: {
        bucket: 'b',
        endpoint: 'https://s3',
        region: 'r',
        accessKeyId: 'a',
        secretAccessKey: 's',
      },
    });

    expect(exports[0].encryption).toBeUndefined();
    expect(recorded[0].encryption).toBeUndefined();
    expect(
      (service as any).retirement.afterEncryptedVolumeCopy,
    ).not.toHaveBeenCalled();
    expect(res.encrypted).toBe(false);
  });

  it('keeps the copy when retiring the old ones fails', async () => {
    const { service } = make();
    (service as any).retirement.afterEncryptedVolumeCopy = jest.fn(async () => {
      throw new Error('bucket unreachable');
    });

    await expect(
      service.createForApp({ applicationId: 'app-1', destinationId: 'dest-1' }),
    ).resolves.toMatchObject({ encrypted: true });
  });
});
