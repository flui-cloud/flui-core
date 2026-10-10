jest.mock('@kubernetes/client-node', () => ({}));

import { clusterMatcher } from './application-metrics.service';
import {
  ApplicationTrafficService,
  TrafficTarget,
  timed,
} from './application-traffic.service';

const service = new ApplicationTrafficService({} as never);
const api: TrafficTarget = {
  slug: 'flui-api',
  namespace: 'flui-system',
  port: 3000,
  portProtocol: 'http',
};
const app: TrafficTarget = {
  slug: 'shop',
  namespace: 'p-team-1',
  port: 8080,
  portProtocol: 'http',
};

describe('which Traefik routes belong to an application', () => {
  it('finds an application through its own Ingress, a platform Ingress and an IngressRoute', () => {
    expect(
      service.servesTraefikService(app, 'p-team-1-shop-svc-8080@kubernetes'),
    ).toBe(true);
    expect(
      service.servesTraefikService(api, 'flui-system-flui-api-3000@kubernetes'),
    ).toBe(true);
    expect(
      service.servesTraefikService(
        api,
        'flui-system-flui-api-c8a163b3e11ee4d8dcd6@kubernetescrd',
      ),
    ).toBe(true);
  });

  it('never takes a neighbour whose name starts the same', () => {
    expect(
      service.servesTraefikService(app, 'p-team-1-shop-v2-svc-8080@kubernetes'),
    ).toBe(false);
    expect(
      service.servesTraefikService(
        app,
        'p-team-1-shop-admin-c8a163b3e11ee4d8dcd6@kubernetescrd',
      ),
    ).toBe(false);
    expect(
      service.servesTraefikService(app, 'p-team-1-shop-svc-9090@kubernetes'),
    ).toBe(false);
  });

  it('adds up the routes when the summary is read', () => {
    const byService = new Map([
      [
        'flui-system-flui-api-3000@kubernetes',
        { rps: 1, serverErrorPercent: 0, p95: 0.1 },
      ],
      [
        'flui-system-flui-api-c8a163b3e11ee4d8dcd6@kubernetescrd',
        { rps: 99, serverErrorPercent: 10, p95: 0.8 },
      ],
      [
        'flui-system-flui-web-80@kubernetes',
        { rps: 50, serverErrorPercent: 0, p95: 0.05 },
      ],
    ]);
    expect(service.summaryFor(api, byService)).toEqual({
      rps: 100,
      serverErrorPercent: 9.9,
      p95: 0.8,
    });
  });

  it('has nothing to read for an application that takes no HTTP', () => {
    expect(
      service.traefikServicePattern({ ...app, portProtocol: 'tcp' as const }),
    ).toBeNull();
  });
});

describe("keeping an application's series to its cluster", () => {
  it('matches its cluster, and series recorded before the rules carried one', () => {
    expect(clusterMatcher('23080e08-df4e-4234-b0b2-acc69f629110')).toBe(
      ',cluster_id=~"23080e08-df4e-4234-b0b2-acc69f629110|"',
    );
  });

  it('adds nothing it cannot trust', () => {
    expect(clusterMatcher(undefined)).toBe('');
    expect(clusterMatcher('x"} or vector(1)')).toBe('');
  });
});

describe('latency leaves long connections out', () => {
  it('adds the protocol matcher to a selector, or makes one', () => {
    expect(timed('{service=~"a|b"}')).toBe(
      '{service=~"a|b",protocol!~"websocket|sse"}',
    );
    expect(timed('')).toBe('{protocol!~"websocket|sse"}');
  });
});
