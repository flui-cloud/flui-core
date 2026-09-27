jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));
jest.mock('ip-cidr', () => ({}));

import {
  SqliteVolumeExclusionService,
  VELERO_VOLUME_EXCLUDES,
} from './sqlite-volume-exclusion.service';

describe('SQLite volumes left to their copies', () => {
  const make = (pods: any[]) => {
    const qb: any = {};
    for (const m of ['select', 'addSelect', 'distinct', 'where', 'andWhere']) {
      qb[m] = jest.fn(() => qb);
    }
    qb.getRawMany = jest.fn(async () => [
      { applicationId: 'app-1', volumeName: 'data-ld-0' },
    ]);
    const k8s = {
      listResources: jest.fn(async () => pods),
      mergePatchObject: jest.fn(async () => undefined),
    };
    const service = new SqliteVolumeExclusionService(
      k8s as any,
      { createQueryBuilder: () => qb } as any,
      { findOne: jest.fn(async () => ({ k8sNamespace: 'ns' })) } as any,
    );
    return { service, k8s };
  };

  const pod = (annotations: Record<string, string> = {}) => ({
    metadata: { name: 'ld-0', annotations },
    spec: {
      volumes: [
        { name: 'data', persistentVolumeClaim: { claimName: 'data-ld-0' } },
        { name: 'tmp', emptyDir: {} },
      ],
    },
  });

  it('annotates the running pod with the volume, keeping what was there', async () => {
    const { service, k8s } = make([pod({ [VELERO_VOLUME_EXCLUDES]: 'cache' })]);
    await expect(service.excludeCoveredVolumes('kc', 'c1')).resolves.toEqual([
      'ns/ld-0/data',
    ]);
    expect(k8s.mergePatchObject).toHaveBeenCalledWith('kc', {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: 'ld-0',
        namespace: 'ns',
        annotations: { [VELERO_VOLUME_EXCLUDES]: 'cache,data' },
      },
    });
  });

  it('does not patch a pod that already says so', async () => {
    const { service, k8s } = make([pod({ [VELERO_VOLUME_EXCLUDES]: 'data' })]);
    await service.excludeCoveredVolumes('kc', 'c1');
    expect(k8s.mergePatchObject).not.toHaveBeenCalled();
  });
});
