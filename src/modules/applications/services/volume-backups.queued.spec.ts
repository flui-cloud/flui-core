jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));
jest.mock('ip-cidr', () => ({}));

import { VolumeBackupsService } from './volume-backups.service';

function make(opts: { destinationExists?: boolean } = {}) {
  const service = Object.create(
    VolumeBackupsService.prototype,
  ) as VolumeBackupsService;
  const r = service as any;
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
  r.encryptionService = {
    decrypt: (v: string) => v.replace(/^sealed:/, ''),
    encrypt: (v: string) => `sealed:${v}`,
  };
  r.volumeExportFactory = { getOrFail: () => ({ capabilities: {} }) };
  r.appResourcesRepository = { findByApplicationId: async () => [] };
  r.volumeClaims = {
    resolveForApplication: async () => [{ name: 'data-web' }],
  };
  r.destinationRepository = {
    findOne: async () =>
      opts.destinationExists === false ? null : { id: 'dest-1' },
  };
  r.runner = {
    open: jest.fn(async () => ({ id: 'op-1' })),
    failIfPending: jest.fn(async () => undefined),
  };
  r.queue = { add: jest.fn(async () => undefined) };
  return { service, r };
}

describe('a backup a person asks for is answered with an operation', () => {
  it('queues the copy with the volume resolved and bucket credentials sealed', async () => {
    const { service, r } = make();
    const started = await service.startForApp({
      applicationId: 'app-1',
      userId: 'u1',
      destination: {
        bucket: 'b',
        endpoint: 'https://s3',
        region: 'r',
        accessKeyId: 'AKID',
        secretAccessKey: 'SECRET',
      },
    });
    expect(started).toEqual({
      operationId: 'op-1',
      applicationId: 'app-1',
      volumeName: 'data-web',
      status: 'pending',
    });
    const [name, data] = r.queue.add.mock.calls[0];
    expect(name).toBe('app-volume-backup');
    expect(data.request).toMatchObject({
      applicationId: 'app-1',
      volumeName: 'data-web',
      operationId: 'op-1',
    });
    expect(data.request.destination).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain('"SECRET"');
    expect(data.destinationSealed.startsWith('sealed:')).toBe(true);
  });

  it('refuses at once what can be refused cheaply, before any operation exists', async () => {
    const { service, r } = make({ destinationExists: false });
    await expect(
      service.startForApp({ applicationId: 'app-1', destinationId: 'nope' }),
    ).rejects.toThrow('Backup destination nope not found');
    expect(r.runner.open).not.toHaveBeenCalled();
    expect(r.queue.add).not.toHaveBeenCalled();
  });

  it('closes the operation when the queued copy fails before it starts reporting', async () => {
    const { service, r } = make();
    const refusal = Object.assign(new Error('refused'), {
      response: { code: 'VOLUME_COPY_REFUSED' },
    });
    jest.spyOn(service, 'createForApp').mockRejectedValue(refusal);
    await service.runQueued({
      request: { applicationId: 'app-1', operationId: 'op-1' },
      destinationSealed: 'sealed:{"bucket":"b"}',
    });
    expect(service.createForApp).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: 'op-1',
        destination: { bucket: 'b' },
      }),
    );
    expect(r.runner.failIfPending).toHaveBeenCalledWith('op-1', refusal);
  });
});
