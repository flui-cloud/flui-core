import { scalingFromManifest } from './manifest-scaling.util';
import { ApplicationManifest } from '../interfaces/application-manifest.interface';

const manifestWith = (scaling?: { min?: number; max?: number }) =>
  ({ deploy: { port: 3000, scaling } }) as unknown as ApplicationManifest;

describe('scalingFromManifest', () => {
  it('leaves the app alone when the manifest declares no range', () => {
    expect(scalingFromManifest(manifestWith(), { enabled: true })).toEqual({});
  });

  it('turns a range that can grow into replica autoscaling', () => {
    expect(scalingFromManifest(manifestWith({ min: 1, max: 3 }), null)).toEqual(
      {
        scaling: { enabled: true, minReplicas: 1, maxReplicas: 3 },
        replicas: 1,
      },
    );
  });

  it('reads a range that cannot grow as a fixed count', () => {
    expect(scalingFromManifest(manifestWith({ min: 2, max: 2 }), null)).toEqual(
      {
        scaling: { enabled: false, minReplicas: 2, maxReplicas: 2 },
        replicas: 2,
      },
    );
  });

  it('never stops the app with min 0, and never lets max sit under min', () => {
    expect(scalingFromManifest(manifestWith({ min: 0, max: 0 }), null)).toEqual(
      {
        scaling: { enabled: false, minReplicas: 1, maxReplicas: 1 },
        replicas: 1,
      },
    );
  });

  it('keeps a target a person set on the app', () => {
    const out = scalingFromManifest(manifestWith({ min: 1, max: 4 }), {
      enabled: false,
      targetCPU: 60,
    });
    expect(out.scaling).toEqual({
      enabled: true,
      targetCPU: 60,
      minReplicas: 1,
      maxReplicas: 4,
    });
  });
});
