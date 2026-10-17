jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));
jest.mock('../../common/leadership/advisory-lock', () =>
  jest.requireActual('../../common/leadership/testing/fake-advisory-locks'),
);

import { AppMigrationProcessor } from './app-migration.processor';
import {
  AppCutoverMode,
  AppMigrationStatus,
} from '../enums/app-migration.enum';

const A_IP = '1.1.1.1';
const B_IP = '2.2.2.2';

const host = {
  fqdn: 'shop.example.com',
  namespace: 'ns',
  endpointIds: ['ep-1'],
  secretName: 'tls-shop-example-com',
  certificate: 'dns-01',
  certificateReady: true,
  certificateMessage: null,
  certificateRequired: true,
};

const ZONES: Record<string, any> = {
  za: { id: 'za', clusterId: 'A', dnsZoneId: 'dz' },
  zb: { id: 'zb', clusterId: 'B', dnsZoneId: 'dz' },
};

function setup(
  opts: {
    src?: string;
    dst?: string;
    bridge?: any;
    status?: AppMigrationStatus;
    reconcileResults?: (boolean | undefined)[];
    certProblem?: string | null;
    routeOnTargetFails?: boolean;
    staleAfterFlip?: boolean;
    staleReadsAfterFlip?: number;
    sharedWith?: any[];
  } = {},
) {
  const src = opts.src ?? 'A';
  const dst = opts.dst ?? 'B';
  const calls: string[] = [];
  const app: any = { id: 'app-1', slug: 'shop', clusterId: src, replicas: 2 };
  const mig: any = {
    id: 'mig-1',
    srcAppId: app.id,
    srcClusterId: src,
    targetClusterId: dst,
    userId: 'user-1',
    cutoverMode: AppCutoverMode.MANUAL,
    status: opts.status ?? AppMigrationStatus.READY,
    bridgeState:
      opts.bridge === undefined
        ? {
            mode: 'bridge',
            skipReason: null,
            state: 'preparing',
            hosts: [host],
          }
        : opts.bridge,
  };
  const ep: any = {
    id: 'ep-1',
    fqdn: 'shop.example.com',
    applicationId: app.id,
    clusterId: src,
    clusterDnsZoneId: src === 'A' ? 'za' : 'zb',
    dnsHeldBy: null,
    dnsRecordValue: src === 'A' ? A_IP : B_IP,
    wildcardCertificateId: 'wild-src',
    tlsSecretName: 'wildcard-src-tls',
  };
  let flipped = false;
  let staleReads = opts.staleReadsAfterFlip ?? 0;
  const migRepo = {
    manager: {},
    findOne: jest.fn(async () => mig),
    save: jest.fn(async (m: any) => m),
    update: jest.fn(async () => undefined),
  };
  const appRepo = {
    findOne: jest.fn(async () => app),
    save: jest.fn(async (a: any) => {
      calls.push(`rebind-app:${a.clusterId}`);
      return a;
    }),
  };
  const endpointRepo = {
    find: jest.fn(async ({ where }: any) =>
      where?.fqdn ? [{ ...ep }, ...(opts.sharedWith ?? [])] : [{ ...ep }],
    ),
    save: jest.fn(async (e: any) => {
      Object.assign(ep, e);
      calls.push(`endpoint-save:${e.clusterId}`);
      return e;
    }),
    update: jest.fn(async (_id: string, patch: any) => {
      Object.assign(ep, patch);
      if ('clusterId' in patch) {
        calls.push(
          `endpoint:${patch.clusterId}:${patch.clusterDnsZoneId}:${patch.dnsHeldBy}`,
        );
      } else {
        calls.push('endpoint-release');
      }
    }),
  };
  const zoneRepo = {
    findOne: jest.fn(async ({ where }: any) =>
      where.id
        ? ZONES[where.id]
        : Object.values(ZONES).find(
            (z) =>
              z.clusterId === where.clusterId &&
              z.dnsZoneId === where.dnsZoneId,
          ),
    ),
  };
  const opRepo = { update: jest.fn(), findOne: jest.fn(), save: jest.fn() };
  const materializer = {
    materializeOnCluster: jest.fn(async () => undefined),
    teardownOnCluster: jest.fn(async () => undefined),
    scaleOnCluster: jest.fn(async (_a: any, c: string, n: number) => {
      calls.push(`scale:${c}:${n}`);
    }),
    waitStoppedOnCluster: jest.fn(async (_a: any, c: string) => {
      calls.push(`stopped:${c}`);
    }),
    waitReadyOnCluster: jest.fn(async (_a: any, c: string) => {
      calls.push(`ready:${c}`);
    }),
  };
  const results = [...(opts.reconcileResults ?? [])];
  const reconciliation = {
    reconcile: jest.fn(async () => {
      if (ep.dnsHeldBy) {
        calls.push('reconcile:held');
        if (opts.routeOnTargetFails) throw new Error('no sign-in check on B');
        return true;
      }
      calls.push('reconcile:flip');
      const result = results.length ? results.shift() : true;
      if (result !== false) flipped = true;
      return result;
    }),
    prepareRouteOn: jest.fn(async (id: string, c: string, secret: string) => {
      calls.push(`prepare-route:${id}:${c}:${secret}`);
    }),
    deleteEndpointResources: jest.fn(async (_id: string, o: any) => {
      calls.push(
        `delete-route:${o?.clusterId}${o?.keepCertificate ? ':keep-cert' : ''}`,
      );
    }),
    publishedAnswer: jest.fn(async () => ({
      published: [
        flipped && !opts.staleAfterFlip && !(staleReads > 0 && staleReads--)
          ? B_IP
          : A_IP,
      ],
      expected: [dst === 'B' ? B_IP : A_IP],
      ttl: 120,
    })),
  };
  const bridge = {
    preflight: jest.fn(async () => ({ mode: 'bridge', skipReason: null })),
    prepare: jest.fn(async () => [host]),
    certificatesValid: jest.fn(async () => opts.certProblem ?? null),
    activate: jest.fn(async () => {
      calls.push('activate');
      return [B_IP];
    }),
    close: jest.fn(async () => {
      calls.push('close');
      return null;
    }),
    discard: jest.fn(async () => undefined),
  };
  const volumes = { warm: jest.fn(), copy: jest.fn() };
  const processor = new (AppMigrationProcessor as any)(
    migRepo,
    opRepo,
    appRepo,
    endpointRepo,
    materializer,
    reconciliation,
    volumes,
    zoneRepo,
    bridge,
  );
  processor.retryDelayMs = 0;
  processor.readBackDelayMs = 0;
  return {
    processor,
    calls,
    mig,
    app,
    ep,
    bridge,
    reconciliation,
    endpointRepo,
  };
}

const cutover = (p: any, mig: any) =>
  p.runCutover({ data: { migrationId: mig.id } });

describe('cutting over through the bridge', () => {
  it('opens the bridge before any DNS write and before the source stops, then moves the name', async () => {
    const { processor, calls, mig, ep } = setup();

    await cutover(processor, mig);

    expect(calls).toEqual([
      'ready:B',
      'endpoint:B:zb:mig-1',
      'reconcile:held',
      'activate',
      'delete-route:A',
      'rebind-app:B',
      'scale:A:0',
      'stopped:A',
      'endpoint-release',
      'reconcile:flip',
    ]);
    expect(mig.status).toBe(AppMigrationStatus.BRIDGING);
    expect(mig.bridgeState).toEqual(
      expect.objectContaining({
        mode: 'bridge',
        state: 'active',
        targetAddresses: [B_IP],
        recordTtlSeconds: 120,
      }),
    );
    expect(mig.bridgeState.activatedAt).toBeDefined();
    expect(mig.bridgeState.dnsFlippedAt).toBeDefined();
    expect(ep.dnsHeldBy).toBeNull();
    expect(ep.wildcardCertificateId).toBeNull();
  });

  it('opens the bridge right after the endpoints move when the destination route was prepared', async () => {
    const { processor, calls, mig } = setup({
      bridge: {
        mode: 'bridge',
        skipReason: null,
        state: 'preparing',
        hosts: [host],
        routePrepared: true,
      },
    });

    await cutover(processor, mig);

    expect(calls.slice(0, 6)).toEqual([
      'ready:B',
      'endpoint:B:zb:mig-1',
      'activate',
      'delete-route:A',
      'reconcile:held',
      'rebind-app:B',
    ]);
    expect(mig.status).toBe(AppMigrationStatus.BRIDGING);
  });

  it('falls back to DNS only, with the reason, when the destination certificate is not valid', async () => {
    const { processor, calls, mig } = setup({
      certProblem:
        'shop.example.com has no valid certificate on the destination',
    });

    await cutover(processor, mig);

    expect(calls).not.toContain('activate');
    expect(mig.bridgeState).toEqual(
      expect.objectContaining({
        mode: 'dns-only',
        skipReason:
          'shop.example.com has no valid certificate on the destination',
      }),
    );
    expect(mig.status).toBe(AppMigrationStatus.COMPLETED);
  });

  it('puts the route back on the source when the destination route cannot be built', async () => {
    const { processor, calls, mig, ep, app } = setup({
      routeOnTargetFails: true,
    });

    await expect(cutover(processor, mig)).rejects.toThrow(/sign-in/);

    expect(calls).not.toContain('activate');
    expect(calls).toContain('endpoint:A:za:null');
    expect(calls).toContain('delete-route:B:keep-cert');
    expect(ep.clusterId).toBe('A');
    expect(app.clusterId).toBe('A');
    expect(mig.status).toBe(AppMigrationStatus.FAILED);
    expect(mig.bridgeState.state).not.toBe('active');
  });

  it('prepares the certificate again when it is no longer valid at cutover', async () => {
    const { processor, calls, mig, bridge } = setup();
    bridge.certificatesValid.mockResolvedValueOnce('expired');

    await cutover(processor, mig);

    expect(bridge.prepare).toHaveBeenCalled();
    expect(calls).toContain('activate');
    expect(mig.status).toBe(AppMigrationStatus.BRIDGING);
  });

  it('waits for the provider to show the new record before calling the switch failed', async () => {
    const { processor, mig } = setup({ staleReadsAfterFlip: 2 });

    await cutover(processor, mig);

    expect(mig.status).toBe(AppMigrationStatus.BRIDGING);
  });

  it('refuses, before anything moves, a hostname another application took since creation', async () => {
    const { processor, calls, mig } = setup({
      sharedWith: [
        { id: 'ep-9', fqdn: 'shop.example.com', applicationId: 'app-other' },
      ],
    });

    await expect(cutover(processor, mig)).rejects.toThrow(/app-other/);

    expect(calls).toEqual([]);
    expect(mig.status).toBe(AppMigrationStatus.FAILED);
  });

  it('resumes after activation without checking the certificate again', async () => {
    const { processor, calls, mig, bridge } = setup({
      status: AppMigrationStatus.CUTOVER,
      bridge: {
        mode: 'bridge',
        skipReason: null,
        state: 'active',
        hosts: [host],
        activatedAt: '2026-10-11T10:00:00.000Z',
      },
    });

    await cutover(processor, mig);

    expect(bridge.certificatesValid).not.toHaveBeenCalled();
    expect(calls).not.toContain('ready:B');
    expect(calls).toContain('reconcile:flip');
    expect(mig.status).toBe(AppMigrationStatus.BRIDGING);
    expect(mig.bridgeState.activatedAt).toBe('2026-10-11T10:00:00.000Z');
  });

  it('fails forward when the name still points at the source after the flip', async () => {
    const { processor, mig } = setup({ staleAfterFlip: true });

    await expect(cutover(processor, mig)).rejects.toThrow(
      /shop\.example\.com still answers/,
    );
    expect(mig.status).toBe(AppMigrationStatus.FAILED);
    expect(mig.bridgeState.state).toBe('active');
  });
});

describe('cutting over by DNS only', () => {
  const dnsOnly = {
    mode: 'dns-only',
    skipReason: 'off',
    state: null,
    hosts: [],
  };

  it('moves the endpoint into the destination zone assignment', async () => {
    const { processor, mig, endpointRepo } = setup({ bridge: dnsOnly });

    await cutover(processor, mig);

    expect(endpointRepo.update).toHaveBeenCalledWith(
      'ep-1',
      expect.objectContaining({ clusterId: 'B', clusterDnsZoneId: 'zb' }),
    );
    expect(mig.status).toBe(AppMigrationStatus.COMPLETED);
  });

  it('moves it back into the source zone assignment on the way home', async () => {
    const { processor, mig, endpointRepo } = setup({
      bridge: dnsOnly,
      src: 'B',
      dst: 'A',
    });

    await cutover(processor, mig);

    expect(endpointRepo.update).toHaveBeenCalledWith(
      'ep-1',
      expect.objectContaining({ clusterId: 'A', clusterDnsZoneId: 'za' }),
    );
  });

  it('retries a reconcile that was skipped because another one was running', async () => {
    const { processor, mig, reconciliation } = setup({
      bridge: dnsOnly,
      reconcileResults: [false, false, true],
    });

    await cutover(processor, mig);

    expect(reconciliation.reconcile).toHaveBeenCalledTimes(3);
    expect(reconciliation.reconcile).toHaveBeenCalledWith('ep-1', {
      nameAlreadyPublished: true,
    });
    expect(mig.status).toBe(AppMigrationStatus.COMPLETED);
    expect(mig.errorMessage).toBeUndefined();
  });

  it('reports a name that did not move instead of calling the cutover clean', async () => {
    const { processor, mig } = setup({ bridge: dnsOnly, staleAfterFlip: true });

    await cutover(processor, mig);

    expect(mig.status).toBe(AppMigrationStatus.COMPLETED);
    expect(mig.errorMessage).toMatch(/shop\.example\.com still answers/);
  });
});

describe('preparing the bridge while provisioning', () => {
  it('prepares the destination certificate before the migration reports READY', async () => {
    const { processor, mig, bridge, calls } = setup({
      status: AppMigrationStatus.PENDING,
      bridge: { mode: 'bridge', skipReason: null, state: null, hosts: [] },
    });

    await processor.run({ data: { migrationId: mig.id } });

    expect(bridge.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        bridgeId: 'mig-1',
        sourceClusterId: 'A',
        targetClusterId: 'B',
      }),
    );
    expect(mig.status).toBe(AppMigrationStatus.READY);
    expect(mig.bridgeState).toEqual(
      expect.objectContaining({
        state: 'preparing',
        hosts: [host],
        routePrepared: true,
      }),
    );
    expect(calls).toContain('prepare-route:ep-1:B:tls-shop-example-com');
  });

  it('keeps going by DNS only, with the reason, when the bridge cannot be prepared', async () => {
    const { processor, mig, bridge } = setup({
      status: AppMigrationStatus.PENDING,
      bridge: { mode: 'bridge', skipReason: null, state: null, hosts: [] },
    });
    bridge.prepare.mockRejectedValueOnce(new Error('cluster B unreachable'));

    await processor.run({ data: { migrationId: mig.id } });

    expect(mig.status).toBe(AppMigrationStatus.READY);
    expect(mig.bridgeState.mode).toBe('dns-only');
    expect(mig.bridgeState.skipReason).toMatch(/cluster B unreachable/);
  });

  it('does not undo an abort that lands while the certificate is prepared', async () => {
    const { processor, mig, bridge } = setup({
      status: AppMigrationStatus.PENDING,
      bridge: { mode: 'bridge', skipReason: null, state: null, hosts: [] },
    });
    const aborted = { ...mig };
    bridge.prepare.mockImplementationOnce(async () => {
      aborted.status = AppMigrationStatus.ABORTED;
      return [host];
    });
    const migRepo = (processor as any).migRepo;
    migRepo.findOne.mockImplementation(async () =>
      aborted.status === AppMigrationStatus.ABORTED ? aborted : mig,
    );

    await processor.run({ data: { migrationId: mig.id } });

    expect(migRepo.update).toHaveBeenCalledWith('mig-1', {
      bridgeState: expect.objectContaining({ hosts: [host] }),
    });
    expect(mig.status).not.toBe(AppMigrationStatus.READY);
    expect(bridge.discard).toHaveBeenCalled();
  });
});

describe('opening the bridge before the database fence (full migration)', () => {
  const prepared = {
    mode: 'bridge',
    skipReason: null,
    state: 'preparing',
    hosts: [host],
    routePrepared: true,
  };

  it('stops once the source forwards: the app stays bound to the source, nothing stops, DNS stays', async () => {
    const { processor, calls, mig, app } = setup({ bridge: { ...prepared } });

    await processor.runBridgeOpen({ data: { migrationId: mig.id } });

    expect(calls).toEqual([
      'ready:B',
      'endpoint:B:zb:mig-1',
      'activate',
      'delete-route:A:keep-cert',
      'reconcile:held',
    ]);
    expect(app.clusterId).toBe('A');
    expect(mig.status).toBe(AppMigrationStatus.CUTOVER);
    expect(mig.bridgeState.state).toBe('active');
    expect(mig.bridgeState.sourceRouteRemovedAt).toBeDefined();
  });

  it('parks at READY by DNS only when the destination certificate is not valid', async () => {
    const { processor, calls, mig } = setup({
      bridge: { ...prepared },
      certProblem: 'no certificate',
    });

    await processor.runBridgeOpen({ data: { migrationId: mig.id } });

    expect(calls).not.toContain('activate');
    expect(mig.status).toBe(AppMigrationStatus.READY);
    expect(mig.bridgeState).toEqual(
      expect.objectContaining({
        mode: 'dns-only',
        skipReason: 'no certificate',
      }),
    );
  });

  it('rolls back route first: the source serves again before the bridge closes, and twice is harmless', async () => {
    const { processor, calls, mig, ep } = setup({
      status: AppMigrationStatus.CUTOVER,
      bridge: { ...prepared, state: 'active', activatedAt: 'x' },
    });
    Object.assign(ep, {
      clusterId: 'B',
      clusterDnsZoneId: 'zb',
      dnsHeldBy: 'mig-1',
    });

    await processor.rollbackBridge(mig);

    expect(calls).toEqual([
      'endpoint:A:za:null',
      'reconcile:flip',
      'close',
      'delete-route:B:keep-cert',
    ]);
    expect(mig.status).toBe(AppMigrationStatus.READY);
    expect(mig.bridgeState).toEqual(
      expect.objectContaining({ state: 'preparing', routePrepared: false }),
    );

    calls.length = 0;
    await processor.rollbackBridge(mig);
    expect(calls).toEqual([]);
  });

  it('finishes from the open bridge after the promote: re-bind, stop the source, move DNS', async () => {
    const { processor, calls, mig } = setup({
      status: AppMigrationStatus.CUTOVER,
      bridge: { ...prepared, state: 'active', activatedAt: 'x' },
    });

    await processor.runCutover({ data: { migrationId: mig.id } });

    expect(calls).not.toContain('activate');
    expect(calls).toEqual(
      expect.arrayContaining(['rebind-app:B', 'scale:A:0', 'reconcile:flip']),
    );
    expect(mig.status).toBe(AppMigrationStatus.BRIDGING);
  });
});

describe('bridge-before-fence fixes after review', () => {
  const prepared = {
    mode: 'bridge',
    skipReason: null,
    state: 'preparing',
    hosts: [host],
    routePrepared: true,
  };

  it('removes the source route for good when it finishes from a bridge opened before the fence', async () => {
    const { processor, calls, mig } = setup({
      status: AppMigrationStatus.CUTOVER,
      bridge: {
        ...prepared,
        state: 'active',
        activatedAt: 'x',
        sourceRouteRemovedAt: 'y',
      },
    });

    await processor.runCutover({ data: { migrationId: mig.id } });

    const rebind = calls.indexOf('rebind-app:B');
    expect(calls.slice(rebind, rebind + 3)).toEqual([
      'rebind-app:B',
      'delete-route:A',
      'scale:A:0',
    ]);
  });

  it('does not leave the bridge recorded as open when activation could not be saved', async () => {
    const { processor, mig } = setup({ bridge: { ...prepared } });
    const migRepo = (processor as any).migRepo;
    let refused = false;
    migRepo.save.mockImplementation(async (m: any) => {
      if (!refused && m.bridgeState?.state === 'active') {
        refused = true;
        throw new Error('database gone');
      }
      return m;
    });

    await expect(
      processor.runBridgeOpen({ data: { migrationId: mig.id } }),
    ).rejects.toThrow(/database gone/);

    expect(mig.status).toBe(AppMigrationStatus.FAILED);
    expect(mig.bridgeState.state).not.toBe('active');
  });

  it('keeps what went wrong while opening the bridge before the fence', async () => {
    const { processor, mig, reconciliation } = setup({
      bridge: { ...prepared },
    });
    reconciliation.deleteEndpointResources.mockRejectedValueOnce(
      new Error('A unreachable'),
    );

    await processor.runBridgeOpen({ data: { migrationId: mig.id } });

    expect(mig.errorMessage).toMatch(/A unreachable/);
  });

  it('binds the app to the destination and gives it the rewired env in one save', async () => {
    const { processor, mig, app } = setup({
      status: AppMigrationStatus.CUTOVER,
      bridge: {
        ...prepared,
        state: 'active',
        activatedAt: 'x',
        sourceRouteRemovedAt: 'y',
      },
    });
    mig.fullMigrationId = 'fm-1';
    mig.provisionOverrides = { env: [{ name: 'DATABASE_URL', value: 'b' }] };
    const appRepo = (processor as any).appRepo;
    const saved: any[] = [];
    appRepo.save.mockImplementation(async (a: any) => {
      saved.push({ clusterId: a.clusterId, env: a.env });
      return a;
    });

    await processor.runCutover({ data: { migrationId: mig.id } });

    expect(saved[0]).toEqual({
      clusterId: 'B',
      env: [{ name: 'DATABASE_URL', value: 'b' }],
    });
    expect(app.env).toEqual([{ name: 'DATABASE_URL', value: 'b' }]);
  });

  it('notes on the leg that its bridge was rolled back', async () => {
    const { processor, mig, ep } = setup({
      status: AppMigrationStatus.CUTOVER,
      bridge: { ...prepared, state: 'active', activatedAt: 'x' },
    });
    Object.assign(ep, { clusterId: 'B', clusterDnsZoneId: 'zb' });

    await processor.rollbackBridge(mig);

    expect(mig.errorMessage).toMatch(/rolled back/);
  });
});
