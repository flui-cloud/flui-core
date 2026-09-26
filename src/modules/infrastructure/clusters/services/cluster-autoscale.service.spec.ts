// `ClusterAutoscaleService` now reaches `KubernetesService`, which imports an
// ESM-only package ts-jest cannot transform. Nothing here calls through it.
jest.mock('@kubernetes/client-node', () => ({}));

import { ClusterAutoscaleService } from './cluster-autoscale.service';
import { AutoscaleWarningLevel } from '../dto/autoscale-status.dto';
import { AUTOSCALE_DEFAULTS } from '../config/autoscale-defaults';
import { AutoscaleActuation } from './autoscale-actuation';

describe('ClusterAutoscaleService.computeWarning', () => {
  const service = new ClusterAutoscaleService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  const thresholds = {
    scaleUpMemoryPct: AUTOSCALE_DEFAULTS.scaleUpMemoryPct,
    scaleUpCpuPct: AUTOSCALE_DEFAULTS.scaleUpCpuPct,
    warnMemoryPct: AUTOSCALE_DEFAULTS.warnMemoryPct,
    dangerMemoryPct: AUTOSCALE_DEFAULTS.dangerMemoryPct,
    warnCpuPct: AUTOSCALE_DEFAULTS.warnCpuPct,
    dangerCpuPct: AUTOSCALE_DEFAULTS.dangerCpuPct,
    cooldownSeconds: AUTOSCALE_DEFAULTS.cooldownSeconds,
  };

  it('returns NONE when metrics are below warn thresholds', () => {
    const result = service.computeWarning(
      50,
      30,
      thresholds,
      AutoscaleActuation.AUTOMATIC,
    );
    expect(result.level).toBe(AutoscaleWarningLevel.NONE);
    expect(result.message).toBeNull();
  });

  it('warns on sustained pressure where nothing adds a node on its own', () => {
    const result = service.computeWarning(
      78,
      30,
      thresholds,
      AutoscaleActuation.NOT_DRIVEN,
    );
    expect(result.level).toBe(AutoscaleWarningLevel.WARN_NEEDS_AUTOSCALE);
    expect(result.message).toContain('nothing adds a node on its own');
  });

  it('returns NONE for warn-level pressure when autoscale enabled', () => {
    const result = service.computeWarning(
      78,
      30,
      thresholds,
      AutoscaleActuation.AUTOMATIC,
    );
    expect(result.level).toBe(AutoscaleWarningLevel.NONE);
  });

  it('returns DANGER_NEEDS_SCALE when memory above danger threshold', () => {
    const result = service.computeWarning(
      92,
      30,
      thresholds,
      AutoscaleActuation.AUTOMATIC,
    );
    expect(result.level).toBe(AutoscaleWarningLevel.DANGER_NEEDS_SCALE);
    expect(result.message).toContain('settle window');
  });

  it('handles null metrics gracefully', () => {
    const result = service.computeWarning(
      null,
      null,
      thresholds,
      AutoscaleActuation.AUTOMATIC,
    );
    expect(result.level).toBe(AutoscaleWarningLevel.NONE);
  });

  it('does not promise a reacting autoscaler where nothing drives one', () => {
    const result = service.computeWarning(
      92,
      30,
      thresholds,
      AutoscaleActuation.NOT_DRIVEN,
    );
    expect(result.level).toBe(AutoscaleWarningLevel.DANGER_NEEDS_SCALE);
    // There is no cooldown anywhere in the engine; it must not be promised one.
    expect(result.message).not.toContain('cooldown');
    expect(result.message).toContain('Add a worker');
  });

  it('points at the operator where Flui cannot create a server', () => {
    const result = service.computeWarning(
      92,
      30,
      thresholds,
      AutoscaleActuation.ALERT_ONLY_UNSIZED,
    );
    expect(result.message).toContain('cannot create a server');
  });

  it('names the two things that would actually relieve the pressure', () => {
    const result = service.computeWarning(
      78,
      30,
      thresholds,
      AutoscaleActuation.NOT_DRIVEN,
    );
    expect(result.level).toBe(AutoscaleWarningLevel.WARN_NEEDS_AUTOSCALE);
    expect(result.message).toContain('Add a worker');
    expect(result.message).toContain('buy automatically');
    // The old advice was to switch on a flag that adds nothing.
    expect(result.message).not.toContain('enable autoscaling');
  });

  it('triggers DANGER on CPU when memory is fine', () => {
    const result = service.computeWarning(
      40,
      88,
      thresholds,
      AutoscaleActuation.AUTOMATIC,
    );
    expect(result.level).toBe(AutoscaleWarningLevel.DANGER_NEEDS_SCALE);
  });
});

describe('ClusterAutoscaleService.getStatus bounds', () => {
  const cluster = {
    id: 'c-1',
    provider: 'ovh',
    minNodes: 1,
    maxNodes: 1,
    nodes: [{ id: 'n-1' }],
  };
  const build = (owned: { min: number | null; max: number | null } | null) =>
    new ClusterAutoscaleService(
      { findOne: jest.fn().mockResolvedValue(cluster) } as never,
      {
        getServerMemoryUsage: jest.fn().mockResolvedValue(10),
        getServerCpuUsage: jest.fn().mockResolvedValue(10),
      } as never,
      {
        describe: jest.fn().mockResolvedValue({
          actuation: AutoscaleActuation.AUTOMATIC,
          message: null,
          facts: { nodeProvisioning: true, driven: true },
        }),
      } as never,
      { read: jest.fn().mockResolvedValue(null) } as never,
      { boundsFor: jest.fn().mockResolvedValue(owned) } as never,
    );

  it('reports the bounds a scaling group owns, the ones adding a node is fenced by', async () => {
    const status = await build({ min: 1, max: 3 }).getStatus('c-1');
    expect(status.maxNodes).toBe(3);
  });

  it('keeps the cluster row bounds where nothing owns them', async () => {
    const status = await build(null).getStatus('c-1');
    expect(status.maxNodes).toBe(1);
  });
});
