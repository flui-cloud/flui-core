import {
  appVolumesFromManifest,
  declaresReplicatedVolume,
  volumeReplicationMismatches,
} from './manifest-volumes.util';

describe('manifest volumes', () => {
  it('turns replicated into the replicated storage class and nothing else', () => {
    expect(
      appVolumesFromManifest([
        { name: 'data', mountPath: '/data', size: '2Gi', replicated: true },
        { name: 'cache', mountPath: '/cache', replicated: false },
      ]),
    ).toEqual([
      {
        name: 'data',
        mountPath: '/data',
        size: '2Gi',
        storageClass: 'flui-replicated',
      },
      { name: 'cache', mountPath: '/cache' },
    ]);
    expect(appVolumesFromManifest(undefined)).toEqual([]);
  });

  it('says whether any volume asks for a copy', () => {
    expect(
      declaresReplicatedVolume([
        { name: 'd', mountPath: '/d', replicated: true },
      ]),
    ).toBe(true);
    expect(declaresReplicatedVolume([{ name: 'd', mountPath: '/d' }])).toBe(
      false,
    );
  });

  it('names existing volumes whose storage the manifest now contradicts', () => {
    expect(
      volumeReplicationMismatches(
        [
          { name: 'data', mountPath: '/data', replicated: true },
          { name: 'logs', mountPath: '/logs' },
          { name: 'new', mountPath: '/new', replicated: true },
          { name: 'kept', mountPath: '/kept', replicated: true },
        ],
        [
          { name: 'data', mountPath: '/data', storageClass: 'flui-local' },
          { name: 'logs', mountPath: '/logs', storageClass: 'flui-replicated' },
          { name: 'kept', mountPath: '/kept', storageClass: 'flui-replicated' },
        ],
      ),
    ).toEqual([
      { name: 'data', declared: true },
      { name: 'logs', declared: false },
    ]);
  });
});
