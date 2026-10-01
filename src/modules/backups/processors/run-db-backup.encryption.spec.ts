jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {},
  KubernetesObjectApi: { makeApiClient: () => ({}) },
  CoreV1Api: class {},
  Exec: class {},
  PatchStrategy: { MergePatch: 'application/merge-patch+json' },
}));

import { RunDbBackupProcessor } from './run-db-backup.processor';
import { BackupEngineClass } from '../enums/backup-engine-class.enum';
import { EncryptionMode } from '../enums/destination-health.enum';

function make(
  cipher: string,
  retirePlaintext = jest.fn(async () => undefined),
) {
  const order: string[] = [];
  const saved: any[] = [];
  const locations: any[] = [];
  const engine = {
    engine: 'postgres',
    enable: jest.fn(async () => undefined),
    baseBackup: jest.fn(async () => 'label-F'),
    info: jest.fn(async () => ({
      latestLabel: 'label-F',
      oldestRecoverable: null,
      newestRecoverable: null,
      backupCount: 1,
    })),
    describeForArtifact: jest.fn(async () => ({
      engine: 'postgres',
      tool: 'pgbackrest',
      catalogSlug: 'postgresql',
      identities: { user: 'u', database: 'd' },
      repository: { objectKeyPrefix: 'pgbackrest/app-1/encrypted/', cipher },
    })),
    artifactObjectPrefix: jest.fn(() => 'unused/'),
    retirePlaintext: jest.fn(async (...args: unknown[]) => {
      order.push('retire');
      return retirePlaintext(...(args as []));
    }),
  };
  const processor = new RunDbBackupProcessor(
    { update: jest.fn(async () => ({})) } as any,
    {
      findById: jest.fn(async () => ({
        id: 'job-1',
        policyId: 'pol-1',
        clusterId: 'cl-1',
      })),
      update: jest.fn(async (_id: string, patch: any) => {
        if (patch.status) order.push(`job:${patch.status}`);
      }),
    } as any,
    {
      findById: jest.fn(async () => ({
        id: 'pol-1',
        engine: 'postgres',
        engineClass: BackupEngineClass.DATABASE,
        scopeSelector: { applicationIds: ['app-1'] },
        metadata: {},
      })),
      primaryDestinationOf: jest.fn(() => ({ destinationId: 'dest-1' })),
    } as any,
    {
      findById: jest.fn(async () => ({
        id: 'dest-1',
        encryptionMode: EncryptionMode.FLUI_MANAGED,
      })),
    } as any,
    {
      createArtifact: jest.fn((a: any) => a),
      saveArtifact: jest.fn(async (a: any) => {
        saved.push(a);
        return { ...a, id: 'art-1' };
      }),
      saveLocation: jest.fn(async (l: any) => {
        locations.push(l);
        return l;
      }),
    } as any,
    { forEngine: jest.fn(() => engine) } as any,
  );
  const handle = () =>
    processor.handle({
      data: { backupJobId: 'job-1', operationId: 'op-1' },
    } as any);
  return { handle, engine, saved, locations, order };
}

describe('RunDbBackupProcessor — what a database artifact says about its encryption', () => {
  it('records the repository and the cipher it reported', async () => {
    const t = make('aes-256-cbc');
    await t.handle();
    expect(t.saved[0].manifestSummary.repository).toEqual({
      objectKeyPrefix: 'pgbackrest/app-1/encrypted/',
      cipher: 'aes-256-cbc',
    });
    expect(t.saved[0].encryptionMode).toBe(EncryptionMode.FLUI_MANAGED);
    expect(t.locations[0].objectKeyPrefix).toBe('pgbackrest/app-1/encrypted/');
  });

  it('never claims encryption the repository did not report', async () => {
    const t = make('none');
    await t.handle();
    expect(t.saved[0].encryptionMode).toBe(EncryptionMode.NONE);
  });

  it('retires plaintext copies only after the job is recorded as completed', async () => {
    const t = make('aes-256-cbc');
    await t.handle();
    expect(t.order).toEqual(['job:running', 'job:completed', 'retire']);
    expect(t.engine.retirePlaintext).toHaveBeenCalledWith(
      'app-1',
      expect.objectContaining({ id: 'art-1' }),
    );
  });

  it('a failed retirement does not fail the backup', async () => {
    const t = make(
      'aes-256-cbc',
      jest.fn(async () => {
        throw new Error('bucket said no');
      }),
    );
    await expect(t.handle()).resolves.toBeUndefined();
    expect(t.order).toContain('job:completed');
  });
});
