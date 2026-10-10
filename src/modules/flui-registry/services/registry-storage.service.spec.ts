jest.mock('@kubernetes/client-node', () => ({}));

import { BadRequestException, ConflictException } from '@nestjs/common';
import { fluiRegistryConfigFrom } from '../flui-registry.config';
import { StorageBackendProvider } from '../../storage/enums/storage-backend-provider.enum';
import { RegistryStorageService } from './registry-storage.service';

function harness(healthy = true, backend = 'filesystem') {
  const rows: Array<Record<string, any>> = [];
  const tested: Array<Record<string, unknown>> = [];
  const removed: string[] = [];
  const service = new RegistryStorageService(
    {
      findOne: async ({ where }: any) =>
        rows.find((r) =>
          where.id ? r.id === where.id : r.active === where.active,
        ) ?? null,
      find: async () => [...rows],
      delete: async ({ id }: any) => {
        rows.splice(
          rows.findIndex((r) => r.id === id),
          1,
        );
      },
      update: async (where: any, patch: any) =>
        rows
          .filter((r) => r.active === where.active)
          .forEach((r) => Object.assign(r, patch)),
      create: (r: any) => ({
        ...r,
        createdAt: new Date('2026-10-09T00:00:00Z'),
      }),
      save: async (r: any) => {
        if (!rows.includes(r)) rows.push({ id: `b${rows.length + 1}`, ...r });
        return r;
      },
    } as never,
    {
      encrypt: (v: string) => `enc(${v})`,
      decrypt: (v: string) => v.slice(4, -1),
    } as never,
    {
      testConnection: async (creds: Record<string, unknown>) => {
        tested.push(creds);
        return healthy
          ? { healthy: true }
          : { healthy: false, error: 'AccessDenied' };
      },
      emptyAndDeleteBucket: async (creds: Record<string, unknown>) => {
        removed.push(
          `bucket:${String(creds.bucket)}:${String(creds.secretKey)}`,
        );
      },
    } as never,
    {
      teardown: async (resources: Record<string, string>) => {
        removed.push(`project:${resources.projectId}`);
      },
    } as never,
    fluiRegistryConfigFrom(
      (key) =>
        ({
          FLUI_IMAGE_REGISTRY: 'flui',
          FLUI_REGISTRY_STORAGE_BACKEND: backend,
        })[key],
    ),
  );
  return { service, rows, tested, removed };
}

const input = {
  provider: StorageBackendProvider.SCALEWAY_OBJECT_STORAGE,
  endpoint: 'https://s3.fr-par.scw.cloud',
  region: 'fr-par',
  bucket: 'flui-registry-abc',
  accessKey: 'SCWKEY',
  secretKey: 'scw-secret',
  providerResources: { projectId: 'p1' },
};

describe('the bucket the registry keeps images in', () => {
  it('keeps the credential sealed and hands it back only to render the registry', async () => {
    const { service, rows } = harness();
    await service.connect(input);

    expect(rows[0].accessKeyEncrypted).toBe('enc(SCWKEY)');
    expect(rows[0].secretKeyEncrypted).toBe('enc(scw-secret)');
    expect(JSON.stringify(rows[0])).not.toContain('"scw-secret"');
    const connected = await service.connected();
    expect(connected?.s3).toMatchObject({
      bucket: 'flui-registry-abc',
      secretKey: 'scw-secret',
      prefix: 'zot',
    });
    expect(connected?.cachePassword.length).toBeGreaterThan(20);
  });

  it('reports where it points and never the credential', async () => {
    const { service } = harness();
    const status = await service.connect(input);
    expect(status).toMatchObject({
      connected: true,
      bucket: 'flui-registry-abc',
      region: 'fr-par',
    });
    expect(JSON.stringify(status)).not.toMatch(/SCWKEY|scw-secret/);
  });

  it('refuses a credential that cannot write to the bucket, and keeps what was there', async () => {
    const ok = harness();
    await ok.service.connect(input);
    const bad = harness(false);
    await expect(bad.service.connect(input)).rejects.toThrow(
      /cannot write to flui-registry-abc: AccessDenied/,
    );
    expect(bad.rows).toHaveLength(0);
  });

  it('replaces the active bucket and keeps the old one recorded for teardown', async () => {
    const { service, rows } = harness();
    await service.connect(input);
    await service.connect({ ...input, bucket: 'flui-registry-new' });
    expect(rows.map((r) => [r.bucket, r.active])).toEqual([
      ['flui-registry-abc', false],
      ['flui-registry-new', true],
    ]);
  });

  it('does not offer Hetzner Object Storage, whose cost is fixed', async () => {
    const { service, tested } = harness();
    await expect(
      service.connect({
        ...input,
        provider: StorageBackendProvider.HETZNER_OBJECT_STORAGE,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tested).toHaveLength(0);
  });

  it('removes a bucket Flui created with its images, then what it created around it', async () => {
    const { service, rows, removed } = harness();
    await service.connect(input);
    await service.connect({
      ...input,
      bucket: 'flui-registry-new',
      providerResources: { projectId: 'p2' },
    });

    const listed = await service.list();
    expect(listed.map((b) => [b.bucket, b.active, b.createdByFlui])).toEqual([
      ['flui-registry-abc', false, true],
      ['flui-registry-new', true, true],
    ]);
    expect(JSON.stringify(listed)).not.toContain('scw-secret');

    await expect(service.remove('b1')).resolves.toEqual({
      bucket: 'flui-registry-abc',
      bucketDeleted: true,
    });
    expect(removed).toEqual([
      'bucket:flui-registry-abc:scw-secret',
      'project:p1',
    ]);
    expect(rows.map((r) => r.bucket)).toEqual(['flui-registry-new']);
  });

  it('only forgets a bucket of your own', async () => {
    const { service, removed } = harness();
    await service.connect({
      ...input,
      provider: StorageBackendProvider.GENERIC_S3,
      providerResources: undefined as never,
    });
    await expect(service.remove('b1')).resolves.toMatchObject({
      bucketDeleted: false,
    });
    expect(removed).toEqual([]);
  });

  it('never removes the bucket the registry serves from', async () => {
    const { service, removed } = harness(true, 's3');
    await service.connect(input);
    await expect(service.remove('b1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(removed).toEqual([]);
  });

  it('resumes a removal that stopped after the bucket was gone, without touching it again', async () => {
    const { service, rows, removed } = harness();
    await service.connect(input);
    rows[0].active = false;
    rows[0].providerResources = {
      projectId: 'p1',
      bucketDeletedAt: '2026-10-09T00:00:00Z',
    };
    await service.remove('b1');
    expect(removed).toEqual(['project:p1']);
  });
});
