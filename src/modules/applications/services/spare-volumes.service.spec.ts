jest.mock('@kubernetes/client-node', () => ({}));

import { ConflictException, NotFoundException } from '@nestjs/common';
import { SpareVolumesService, replacesLabel } from './spare-volumes.service';

function build(mountedBy: Record<string, string[]> = {}) {
  const claims = [
    {
      metadata: { name: 'data-pg-0', labels: { 'flui-app-id': 'a1' } },
      spec: {},
    },
    {
      metadata: {
        name: 'data-pg-0-restored-20260926211450',
        creationTimestamp: new Date('2026-09-26T21:14:50Z'),
        labels: {
          'flui-app-id': 'a1',
          'flui.cloud/restored-from': 'snap-1',
          'flui.cloud/replaces': 'data-pg-0',
        },
      },
      spec: { resources: { requests: { storage: '5Gi' } } },
    },
    {
      metadata: {
        name: 'data-pg-0-previous-20260927100000',
        creationTimestamp: '2026-09-27T10:00:00Z',
        labels: { 'flui-app-id': 'a1', 'flui.cloud/previous-volume': 'true' },
      },
      spec: { resources: { requests: { storage: '5Gi' } } },
    },
  ];
  const k8s = {
    listResourcesByLabel: jest.fn().mockResolvedValue(claims),
    getResource: jest.fn(
      async (_kc: string, _k: string, name: string) =>
        claims.find((c) => c.metadata.name === name) ?? null,
    ),
    findPodsMountingPvc: jest.fn(
      async (_kc: string, _ns: string, name: string) => mountedBy[name] ?? [],
    ),
    deleteResource: jest.fn().mockResolvedValue(undefined),
  };
  const service = new SpareVolumesService(
    {
      findOne: jest.fn().mockResolvedValue({ kubeconfigEncrypted: 'x' }),
    } as never,
    {
      findById: jest.fn().mockResolvedValue({
        id: 'a1',
        clusterId: 'c1',
        k8sNamespace: 'user-a',
      }),
    } as never,
    k8s as never,
    { decrypt: () => 'kc' } as never,
  );
  return { service, k8s };
}

describe('SpareVolumesService', () => {
  it('lists the restored and previous volumes, not the one in use by design', async () => {
    const { service } = build();
    const spare = await service.list('a1');
    expect(spare.map((s) => [s.name, s.kind])).toEqual([
      ['data-pg-0-previous-20260927100000', 'previous'],
      ['data-pg-0-restored-20260926211450', 'restored'],
    ]);
  });

  it('says which volume a restored copy replaces, when it was recorded', async () => {
    const { service } = build();
    const spare = await service.list('a1');
    expect(spare.map((s) => s.replaces)).toEqual([null, 'data-pg-0']);
    expect(replacesLabel('x'.repeat(64))).toEqual({});
    expect(replacesLabel(undefined)).toEqual({});
  });

  it('deletes a spare volume nobody mounts', async () => {
    const { service, k8s } = build();
    await service.remove('a1', 'data-pg-0-restored-20260926211450');
    expect(k8s.deleteResource).toHaveBeenCalled();
  });

  it('refuses the application own volume and a mounted one', async () => {
    const { service } = build({
      'data-pg-0-previous-20260927100000': ['pg-0'],
    });
    await expect(service.remove('a1', 'data-pg-0')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      service.remove('a1', 'data-pg-0-previous-20260927100000'),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
