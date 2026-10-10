jest.mock('@kubernetes/client-node', () => ({}));

import { AlertEventsService } from '../../observability/services/alert-events.service';
import { AlertRoutingService } from '../../observability/services/alert-routing.service';
import { fluiRegistryConfigFrom } from '../flui-registry.config';
import { RegistryUsageService } from './registry-usage.service';

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

const harness = (
  env: Record<string, string>,
  blobsByApp: Record<string, Array<[string, number]>>,
  openSince?: Date,
) => {
  const recorded: Array<Record<string, any>> = [];
  const delivered: Array<{ kind: string; owner: unknown }> = [];
  const recorder = {
    openEpisodes: async () =>
      new Map(openSince ? [['flui-registry-space', openSince]] : []),
    record: async (alerts: Array<Record<string, any>>) => {
      recorded.push(...alerts);
      return alerts.map((a) => ({
        kind: a.status === 'firing' ? 'fired' : 'resolved',
        event: a,
      }));
    },
  };
  const routing = {
    deliver: async (kind: string, _event: unknown, subject: any) => {
      delivered.push({ kind, owner: subject.ownerUserId });
    },
  };
  const service = new RegistryUsageService(
    fluiRegistryConfigFrom(
      (key) => ({ FLUI_IMAGE_REGISTRY: 'flui', ...env })[key],
    ),
    {
      repositoryBlobs: async (id: string) => {
        if (!blobsByApp[id]) throw new Error('unreachable');
        return new Map(blobsByApp[id]);
      },
    } as never,
    {
      find: async () =>
        Object.keys(blobsByApp)
          .concat('broken')
          .map((id) => ({ id, name: `app-${id}` })),
    } as never,
    { get: async () => undefined, set: async () => undefined } as never,
    {
      get: (token: unknown) =>
        token === AlertEventsService
          ? recorder
          : token === AlertRoutingService
            ? routing
            : null,
    } as never,
  );
  return { service, recorded, delivered };
};

describe('the space the registry takes', () => {
  it('counts a layer two applications share once in the total and once in each of them', async () => {
    const { service } = harness(
      {},
      {
        a: [
          ['sha256:base', 30 * MIB],
          ['sha256:a', 5 * MIB],
        ],
        b: [
          ['sha256:base', 30 * MIB],
          ['sha256:b', 1 * MIB],
        ],
      },
    );
    const usage = await service.measure();
    expect(usage.totalBytes).toBe(36 * MIB);
    expect(usage.applications).toEqual([
      { applicationId: 'a', name: 'app-a', bytes: 35 * MIB },
      { applicationId: 'b', name: 'app-b', bytes: 31 * MIB },
    ]);
    expect(usage.unreadable).toBe(1);
  });

  it('alerts on a volume at a share of its size', async () => {
    const { service } = harness(
      { FLUI_REGISTRY_STORAGE: '1Gi', FLUI_REGISTRY_SPACE_ALERT_PERCENT: '50' },
      { a: [['sha256:a', 600 * MIB]] },
    );
    const usage = await service.measure();
    expect(usage.capacityBytes).toBe(GIB);
    expect(usage.alertBytes).toBe(512 * MIB);
    expect(usage.alerting).toBe(true);
  });

  it('alerts on a bucket at a number of GiB, since it never fills', async () => {
    const { service } = harness(
      {
        FLUI_REGISTRY_STORAGE_BACKEND: 's3',
        FLUI_REGISTRY_SPACE_ALERT_GIB: '2',
      },
      { a: [['sha256:a', GIB]] },
    );
    const usage = await service.measure();
    expect(usage.capacityBytes).toBeNull();
    expect(usage.alertBytes).toBe(2 * GIB);
    expect(usage.alerting).toBe(false);
  });

  it('can be turned off', async () => {
    const { service, recorded } = harness(
      { FLUI_REGISTRY_SPACE_ALERT_PERCENT: '0' },
      { a: [['sha256:a', 30 * GIB]] },
    );
    const usage = await service.measure();
    expect(usage.alertBytes).toBeNull();
    await service.alertOn(usage);
    expect(recorded).toHaveLength(0);
  });

  it('tells the administrators when it crosses the alert, and when it is back under', async () => {
    const over = harness(
      { FLUI_REGISTRY_STORAGE: '1Gi' },
      { a: [['sha256:a', 900 * MIB]] },
    );
    await over.service.alertOn(await over.service.measure());
    expect(over.recorded[0]).toMatchObject({
      fingerprint: 'flui-registry-space',
      status: 'firing',
      fluiKind: 'registry',
      alertname: 'FluiRegistrySpace',
    });
    expect(over.delivered).toEqual([{ kind: 'fired', owner: null }]);

    const since = new Date('2026-10-01T00:00:00Z');
    const under = harness(
      { FLUI_REGISTRY_STORAGE: '1Gi' },
      { a: [['sha256:a', 10 * MIB]] },
      since,
    );
    await under.service.alertOn(await under.service.measure());
    expect(under.recorded[0]).toMatchObject({
      status: 'resolved',
      startsAt: since,
    });
    expect(under.delivered).toEqual([{ kind: 'resolved', owner: null }]);
  });

  it('says nothing while it stays under the alert', async () => {
    const { service, recorded } = harness({}, { a: [['sha256:a', MIB]] });
    await service.alertOn(await service.measure());
    expect(recorded).toHaveLength(0);
  });
});
