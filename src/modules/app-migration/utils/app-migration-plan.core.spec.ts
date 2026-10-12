import { bindToTarget, volumePlan } from './app-migration-plan.core';

const mig = (over: any = {}): any => ({
  id: 'mig-1',
  targetClusterId: 'dst',
  ...over,
});

describe('volumePlan', () => {
  it('is absent without a volume destination', () => {
    expect(volumePlan(mig())).toBeUndefined();
    expect(volumePlan(mig({ provisionOverrides: {} }))).toBeUndefined();
  });

  it('carries the destination and the dedicated node', () => {
    expect(
      volumePlan(
        mig({
          provisionOverrides: {
            volumeDestinationId: 'dest-1',
            dedicatedNodeName: 'node-b',
          },
        }),
      ),
    ).toEqual({ destinationId: 'dest-1', dedicatedNodeName: 'node-b' });
  });
});

describe('bindToTarget', () => {
  it('moves the app to the destination and keeps its env outside a full migration', () => {
    const app: any = { clusterId: 'src', env: [{ name: 'A', value: '1' }] };
    bindToTarget(
      mig({ provisionOverrides: { env: [{ name: 'A', value: '2' }] } }),
      app,
    );
    expect(app).toEqual({ clusterId: 'dst', env: [{ name: 'A', value: '1' }] });
  });

  it('hands a full migration leg the rewired env and the volume node', () => {
    const app: any = { clusterId: 'src', env: [] };
    bindToTarget(
      mig({
        fullMigrationId: 'fm-1',
        provisionOverrides: {
          env: [{ name: 'DATABASE_URL', value: 'b' }],
          volumeDestinationId: 'dest-1',
          dedicatedNodeName: 'node-b',
        },
      }),
      app,
    );
    expect(app).toEqual({
      clusterId: 'dst',
      dedicatedNodeName: 'node-b',
      env: [{ name: 'DATABASE_URL', value: 'b' }],
    });
  });
});
