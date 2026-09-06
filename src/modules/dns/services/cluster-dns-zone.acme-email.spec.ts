jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));

import { ClusterDnsZoneService } from './cluster-dns-zone.service';
import { ReconciliationStatus } from '../../infrastructure/shared/enums/reconciliation-status.enum';

/**
 * A workload cluster in domain mode was born with no ClusterIssuer at all, so
 * no application on it could ever get TLS. Two independent causes, both here:
 * the ACME email had no source beyond the cluster itself, and a failure to read
 * the cluster left every assignment RECONCILING with nothing written down.
 */
describe('ClusterDnsZoneService, the ACME email a cluster issues with', () => {
  const ZONE_ID = 'zone-1';

  function make(opts: {
    /** Assignments of the cluster being reconciled. */
    own?: Record<string, unknown>[];
    /** An assignment of the same zone on some other cluster. */
    elsewhere?: Record<string, unknown> | null;
    /** Emails cert-manager already knows about on this cluster. */
    issuers?: { name: string; email?: string; ready?: boolean }[];
    /** Whether reading the cluster works at all. */
    issuersThrow?: boolean;
    adminEmail?: string;
  }) {
    const own = opts.own ?? [
      { id: 'a-1', clusterId: 'c-1', dnsZoneId: ZONE_ID, acmeEmail: null },
    ];
    const service = Object.create(
      ClusterDnsZoneService.prototype,
    ) as ClusterDnsZoneService;
    const r = service as unknown as Record<string, unknown>;

    r.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    r.clusterDnsZoneRepository = {
      find: jest.fn(async () => own),
      findOne: jest.fn(async () => opts.elsewhere ?? null),
      update: jest.fn(async () => undefined),
    };
    r.getIssuers = jest.fn(async () => {
      if (opts.issuersThrow) throw new Error('has no kubeconfig');
      return opts.issuers ?? [];
    });

    const previous = process.env.ADMIN_EMAIL;
    if (opts.adminEmail === undefined) delete process.env.ADMIN_EMAIL;
    else process.env.ADMIN_EMAIL = opts.adminEmail;
    const restore = () => {
      if (previous === undefined) delete process.env.ADMIN_EMAIL;
      else process.env.ADMIN_EMAIL = previous;
    };

    const resolve = async () => {
      try {
        return await (
          service as unknown as {
            resolveAcmeEmail(id: string): Promise<string | null>;
          }
        ).resolveAcmeEmail('c-1');
      } finally {
        restore();
      }
    };
    return { resolve, r };
  }

  it('uses what the operator entered on the assignment', async () => {
    const h = make({
      own: [
        {
          id: 'a-1',
          clusterId: 'c-1',
          dnsZoneId: ZONE_ID,
          acmeEmail: 'me@x.io',
        },
      ],
      elsewhere: { acmeEmail: 'other@x.io' },
      adminEmail: 'admin@x.io',
    });

    expect(await h.resolve()).toBe('me@x.io');
  });

  it('inherits from the same zone on another cluster before anything global', async () => {
    // Same zone, same operator: a better answer than an installation-wide
    // address, which says nothing about who owns the name.
    const h = make({
      elsewhere: { acmeEmail: 'zone-owner@x.io' },
      adminEmail: 'admin@x.io',
    });

    expect(await h.resolve()).toBe('zone-owner@x.io');
  });

  it('falls back to the installation address the IP path already used', async () => {
    // Without this the domain-mode cluster resolved nothing and applied no
    // issuer, silently, while the IP-mode path on the same process used
    // ADMIN_EMAIL happily.
    const h = make({ adminEmail: 'admin@x.io' });

    expect(await h.resolve()).toBe('admin@x.io');
  });

  it('does not let an unreadable cluster hide the fallback', async () => {
    // The circular source: issuers are what we are trying to create, and on a
    // half-provisioned cluster reading them throws.
    const h = make({ issuersThrow: true, adminEmail: 'admin@x.io' });

    expect(await h.resolve()).toBe('admin@x.io');
  });

  it('returns nothing rather than inventing an address', async () => {
    // A made-up default would register a real ACME account under a name nobody
    // chose and cannot receive mail.
    const h = make({});

    expect(await h.resolve()).toBeNull();
  });
});

describe('ClusterDnsZoneService, an assignment whose cluster cannot be read', () => {
  it('records why instead of leaving it reconciling forever', async () => {
    // Measured: the wizard assigns the zone ~150ms after queueing the cluster,
    // which is ready two and a half minutes later. The reconcile ran against a
    // cluster with no kubeconfig, and both assignments sat in RECONCILING with
    // an empty message for fifteen hours — while the route documents that a
    // zone which cannot be reconciled lands in ERROR with the reason.
    const service = Object.create(
      ClusterDnsZoneService.prototype,
    ) as ClusterDnsZoneService;
    const r = service as unknown as Record<string, unknown>;
    const statuses: { id: string; status: string; message?: string }[] = [];

    r.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    r.clusterDnsZoneRepository = {
      find: jest.fn(async () => [{ id: 'a-1' }, { id: 'a-2' }]),
    };
    r.clusterRepository = { findOne: jest.fn(async () => ({ id: 'c-1' })) };
    r.getKubeconfig = jest.fn(async () => {
      throw new Error('cluster c-1 has no kubeconfig');
    });
    r.updateReconciliationStatus = jest.fn(
      async (id: string, status: string, message?: string) => {
        statuses.push({ id, status, message });
      },
    );

    await (
      service as unknown as {
        refreshAssignmentStatuses(id: string): Promise<void>;
      }
    ).refreshAssignmentStatuses('c-1');

    expect(statuses).toHaveLength(2);
    for (const written of statuses) {
      expect(written.status).toBe(ReconciliationStatus.ERROR);
      expect(written.message).toMatch(/no kubeconfig/);
    }
  });
});

describe('ClusterDnsZoneService, assigning a zone before the cluster exists', () => {
  function make(status: string) {
    const service = Object.create(
      ClusterDnsZoneService.prototype,
    ) as ClusterDnsZoneService;
    const r = service as unknown as Record<string, unknown>;
    const saved: Record<string, unknown>[] = [];

    r.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    r.clusterRepository = {
      findOne: jest.fn(async () => ({ id: 'c-1', status })),
    };
    r.dnsZoneRepository = { findOne: jest.fn(async () => ({ id: 'z-1' })) };
    r.clusterDnsZoneRepository = {
      findOne: jest.fn(async () => null),
      create: jest.fn((v: Record<string, unknown>) => v),
      save: jest.fn(async (v: Record<string, unknown>) => {
        saved.push(v);
        return { ...v, id: 'a-1' };
      }),
    };
    r.reconcileAssignment = jest.fn(async () => undefined);
    return { service, saved, r };
  }

  it('waits instead of reconciling against a cluster that is not there yet', async () => {
    // The wizard assigns ~150ms after queueing creation; the cluster is ready
    // two and a half minutes later. Reconciling now only produced a failure the
    // operator could not act on, and an invitation to click Reconcile.
    const h = make('creating');

    await h.service.assignZoneToCluster('c-1', { dnsZoneId: 'z-1' } as never);

    expect(h.saved[0].reconciliationStatus).toBe(ReconciliationStatus.PENDING);
    expect(h.saved[0].errorMessage).toMatch(/ready/);
    expect(h.r.reconcileAssignment).not.toHaveBeenCalled();
  });

  it('still reconciles at once when the cluster is already up', async () => {
    const h = make('ready');

    await h.service.assignZoneToCluster('c-1', { dnsZoneId: 'z-1' } as never);

    expect(h.saved[0].reconciliationStatus).toBe(
      ReconciliationStatus.RECONCILING,
    );
    expect(h.r.reconcileAssignment).toHaveBeenCalledWith('a-1');
  });
});

describe('ClusterDnsZoneService, rows a restart left mid-reconcile', () => {
  function make() {
    const service = Object.create(
      ClusterDnsZoneService.prototype,
    ) as ClusterDnsZoneService;
    const r = service as unknown as Record<string, unknown>;
    const updates: unknown[][] = [];
    r.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    r.clusterDnsZoneRepository = {
      update: jest.fn(async (...args: unknown[]) => {
        updates.push(args);
        return { affected: 1 };
      }),
    };
    return { service, updates };
  }

  it('releases only the ones with nothing written down', async () => {
    // The in-flight marker carries no message; a truthful "waiting for ACME"
    // always carries the issuer's own text and must survive.
    const h = make();

    await h.service.onApplicationBootstrap();

    const [where, set] = h.updates[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(where.reconciliationStatus).toBe(ReconciliationStatus.RECONCILING);
    expect(where.errorMessage).toBeDefined();
    expect(where.updatedAt).toBeDefined();
    expect(set.reconciliationStatus).toBe(ReconciliationStatus.ERROR);
    expect(set.errorMessage).toMatch(/restart/);
  });
});
