jest.mock('@kubernetes/client-node', () => ({}));

import { TopologyService } from './topology.service';
import { ClusterStatus } from '../../infrastructure/clusters/entities/cluster.entity';

const cluster = {
  id: 'c1',
  name: 'prod',
  provider: 'hetzner',
  region: 'fsn1',
  status: ClusterStatus.READY,
  kubeconfigEncrypted: 'sealed',
};

function make(read: jest.Mock) {
  const service = Object.create(TopologyService.prototype) as TopologyService;
  const r = service as unknown as Record<string, unknown>;
  r.logger = { log: jest.fn(), error: jest.fn(), warn: jest.fn() };
  r.nodeRepo = { find: jest.fn(async () => []) };
  r.peerRepo = { find: jest.fn(async () => []) };
  r.lastGood = new Map();
  r.silentUntil = new Map();
  r.reader = { read };
  const part = (
    service as unknown as {
      buildClusterPart: (
        c: unknown,
      ) => Promise<{ reached: boolean; apps: unknown[] }>;
    }
  ).buildClusterPart.bind(service);
  return { part, errors: (r.logger as { error: jest.Mock }).error };
}

describe('TopologyService, a cluster that does not answer', () => {
  beforeEach(() =>
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] }),
  );
  afterEach(() => jest.useRealTimers());

  const good = {
    cluster,
    reached: true,
    servers: [],
    apps: [{ id: 'a1' }],
    dropped: 0,
  };

  it('keeps its last known apps, drawn as not answering, and says so once', async () => {
    const read = jest
      .fn()
      .mockResolvedValueOnce(good)
      .mockRejectedValue(new Error('Premature close'));
    const { part, errors } = make(read);
    await part(cluster);

    const silent = await part(cluster);
    expect(silent.reached).toBe(false);
    expect(silent.apps).toEqual([{ id: 'a1' }]);
    await part(cluster);
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it('is asked again after a minute, not on every poll', async () => {
    const read = jest.fn().mockRejectedValue(new Error('Premature close'));
    const { part } = make(read);
    await part(cluster);
    await part(cluster);
    await part(cluster);
    expect(read).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(61_000);
    await part(cluster);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('stops the wait at 20 s, so one silent cluster never holds the whole map', async () => {
    const read = jest.fn(() => new Promise(() => undefined));
    const { part } = make(read);
    const answer = part(cluster);
    await jest.advanceTimersByTimeAsync(20_000);
    await expect(answer).resolves.toMatchObject({ reached: false, apps: [] });
  });

  it('forgets apps it has not seen for ten minutes', async () => {
    const read = jest
      .fn()
      .mockResolvedValueOnce(good)
      .mockRejectedValue(new Error('gone'));
    const { part } = make(read);
    await part(cluster);
    jest.advanceTimersByTime(11 * 60_000);
    await expect(part(cluster)).resolves.toMatchObject({
      reached: false,
      apps: [],
    });
  });
});

describe('TopologyService, the dashboard address', () => {
  const withConfig = (env: Record<string, string>) => {
    const service = Object.create(TopologyService.prototype) as TopologyService;
    (service as unknown as Record<string, unknown>).configService = {
      get: (key: string) => env[key],
    };
    return service;
  };

  it('reads it the way every other dashboard link does', () => {
    expect(
      withConfig({
        FRONTEND_URL: 'https://dashboard.acme.io',
        DASHBOARD_URL: 'https://other.acme.io',
      }).dashboardUrl(),
    ).toBe('https://dashboard.acme.io');
    expect(
      withConfig({ DASHBOARD_URL: 'https://other.acme.io' }).dashboardUrl(),
    ).toBe('https://other.acme.io');
    expect(withConfig({}).dashboardUrl()).toBe('http://localhost:4200');
  });
});
