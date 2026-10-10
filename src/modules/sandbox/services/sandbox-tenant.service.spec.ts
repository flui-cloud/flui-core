import { NotFoundException } from '@nestjs/common';
// Provisioning now reaches the catalogue installer, whose import graph pulls in
// ESM-only packages ts-jest cannot transform. The suite drives stubs, so none of
// them is ever constructed.
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { SandboxTenantService } from './sandbox-tenant.service';
import {
  SandboxTenantEntity,
  SandboxTenantState,
} from '../entities/sandbox-tenant.entity';
import { loadSandboxConfig } from '../sandbox.config';

/**
 * Teardown is where a demo silently keeps paying. What matters is not that the
 * happy path works but that a half-failure still deletes the expensive things
 * and still records what it could not finish.
 */

const config = loadSandboxConfig({
  SANDBOX_ENABLED: 'true',
} as NodeJS.ProcessEnv);

const tenantRow: SandboxTenantEntity = {
  id: 't1',
  state: SandboxTenantState.CLAIMED,
  namespace: 'guest-1',
  clusterId: 'c1',
  userId: 'u1',
  email: 'guest-1@try.flui.cloud',
  idpUserId: 'idp-1',
} as SandboxTenantEntity;

const build = (
  breakages: Partial<
    Record<
      | 'namespace'
      | 'idp'
      | 'idpMissing'
      | 'apps'
      | 'apiKeys'
      | 'githubTokens'
      | 'endpoint'
      | 'clusterGone'
      | 'noHeld',
      boolean
    >
  > = {},
) => {
  const calls: string[] = [];
  const marks: Array<{ kind: string; detail?: string }> = [];
  const namespaceLabels: Array<Record<string, string>> = [];
  const recorded: string[] = [];

  const reserve = {
    findClaimed: async () => (breakages.noHeld ? [] : [tenantRow]),
    createPending: async () => ({ ...tenantRow, id: 'new' }),
    recordArea: async (_id: string, fields: { namespace: string }) => {
      calls.push('record-area');
      recorded.push(fields.namespace);
    },
    markReady: async () => marks.push({ kind: 'ready' }),
    markExpired: async () => marks.push({ kind: 'expired' }),
    markWarned: async () => marks.push({ kind: 'warned' }),
    markFailed: async (_id: string, detail: string) =>
      marks.push({ kind: 'failed', detail }),
    getById: async (id: string) => ({
      ...tenantRow,
      id,
      state: marks.some((m) => m.kind === 'failed')
        ? SandboxTenantState.FAILED
        : SandboxTenantState.EXPIRED,
    }),
  };
  const quota = { apply: async () => calls.push('quota') };
  const k8s = {
    ensureNamespaceExists: async (
      _kc: string,
      _ns: string,
      labels: Record<string, string> = {},
    ) => {
      calls.push('ensure-ns');
      namespaceLabels.push(labels);
    },
    applyManifest: async (_kc: string, manifest: string) =>
      calls.push(manifest.includes('NetworkPolicy') ? 'netpol' : 'noindex'),
    deleteNamespace: async () => {
      calls.push('delete-ns');
      if (breakages.namespace) throw new Error('api server down');
    },
  };
  const encryption = { decrypt: () => 'kubeconfig' };
  const directory = {
    createUser: async () => ({ id: 'idp-1', email: tenantRow.email }),
    listUsers: async ({ emailContains }: { emailContains: string }) => {
      calls.push('list-idp');
      // The real directory does a substring match, so the stub returns a
      // near-miss alongside the exact one.
      return [
        { id: 'idp-other', email: `other-${emailContains}` },
        { id: 'idp-1', email: emailContains },
      ];
    },
    deleteUser: async (id: string) => {
      calls.push(`delete-idp:${id}`);
      if (breakages.idpMissing) {
        throw new NotFoundException(`User ${id} not found`);
      }
      if (breakages.idp) throw new Error('idp refused');
    },
  };
  const users = {
    save: async (u: Record<string, unknown>) => ({ ...u, id: 'u1' }),
    create: (u: Record<string, unknown>) => u,
    delete: async () => calls.push('delete-user'),
  };
  const bindings = {
    save: async (b: unknown) => {
      calls.push('binding');
      return b;
    },
    create: (b: unknown) => b,
  };
  const apiKeys = {
    delete: async (where: { userId: string }) => {
      calls.push(`delete-api-keys:${where.userId}`);
      if (breakages.apiKeys) throw new Error('keys locked');
      return { affected: 2 };
    },
  };
  const githubTokens = {
    forget: async (userId: string) => {
      calls.push(`forget-github-tokens:${userId}`);
      if (breakages.githubTokens) throw new Error('tokens locked');
      return 3;
    },
  };
  const applications = {
    find: async () => [
      { id: 'a1', slug: 'web', projectId: 'proj-1', createdAt: new Date(0) },
    ],
    count: async ({
      where,
    }: {
      where: { k8sNamespace: string; deletedAt?: unknown };
    }) =>
      [
        { ns: 'p-area-busy', deleted: false },
        { ns: 'p-area-busy', deleted: false },
        { ns: 'p-area-cleared', deleted: true },
      ].filter(
        (r) =>
          r.ns === where.k8sNamespace && !('deletedAt' in where && r.deleted),
      ).length,
    delete: async () => {
      calls.push('delete-apps');
      if (breakages.apps) throw new Error('fk violation');
    },
  };
  const projects = {
    remove: async (id: string) => calls.push(`delete-project:${id}`),
    removePersonal: async (userId: string) =>
      calls.push(`delete-personal-project:${userId}`),
    createArea: async () => {
      calls.push('project');
      return { id: 'area-project', slug: 'area-1a2b3c4d' };
    },
  };
  // The reaper no longer writes its own binding cleanup: it calls the one the
  // administrative delete uses, which takes both names a binding can carry.
  const userManagement = {
    detachRoleBindings: async (principal: {
      id?: string | null;
      email: string;
    }) => {
      calls.push(`delete-binding:${principal.email}:${principal.id ?? '-'}`);
      return 1;
    },
  };
  const clusters = {
    findOne: async () =>
      breakages.clusterGone ? null : { id: 'c1', kubeconfigEncrypted: 'enc' },
  };
  const appEndpoints = {
    listByNamespace: async () => {
      calls.push('list-endpoints');
      return [{ id: 'ep-1', fqdn: 'guest.example.test' }];
    },
    deleteEndpoint: async (id: string) => calls.push(`delete-endpoint:${id}`),
  };
  const endpointReconciliation = {
    deleteEndpointResources: async (id: string) => {
      calls.push(`delete-endpoint-resources:${id}`);
      if (breakages.endpoint) throw new Error('provider refused');
    },
  };
  const tenancySubdomains = {
    ensureCertificate: async () => {
      calls.push('tenancy-certificate');
      return null;
    },
    releaseCertificates: async () => {
      calls.push('release-tenancy-certificate');
      return 0;
    },
  };

  const deploy = {
    deleteApplication: async (id: string) => {
      calls.push(`delete-app:${id}`);
    },
  };

  const sandboxSubdomains = {
    ensure: async () => {
      calls.push('shared-subdomain');
      return null;
    },
  };

  const service = new SandboxTenantService(
    reserve as never,
    { recordBuild: () => undefined } as never,
    quota as never,
    k8s as never,
    encryption as never,
    directory as never,
    config,
    users as never,
    bindings as never,
    apiKeys as never,
    applications as never,
    clusters as never,
    deploy as never,
    projects as never,
    userManagement as never,
    appEndpoints as never,
    endpointReconciliation as never,
    tenancySubdomains as never,
    sandboxSubdomains as never,
    {
      expiryWarning: async (input: { to: string; apps: string[] }) => {
        calls.push(`warn:${input.to}:${input.apps.join(',')}`);
        return true;
      },
    } as never,
    { origin: 'https://demo.flui.cloud' } as never,
    {
      applyTo: async (
        _kc: string,
        _c: string,
        _ns: string,
        isolated: boolean,
      ) => calls.push(isolated ? 'egress-isolated' : 'egress'),
    } as never,
    githubTokens as never,
    {
      forgetApplication: async (app: { id: string }) => {
        calls.push(`forget-images:${app.id}`);
      },
    } as never,
  );
  return { service, calls, marks, namespaceLabels, recorded };
};

describe('SandboxTenantService.provision', () => {
  it('builds an area with no identity: a project, then its fenced namespace', async () => {
    const { service, calls, marks } = build();
    await service.provision('c1');

    expect(calls).toEqual([
      'project',
      'record-area',
      'ensure-ns',
      'quota',
      'netpol',
      // The way out is the cluster's rule, written as the area is built.
      'egress-isolated',
      'noindex',
      // Before anyone is let in: the first application a guest deploys creates
      // the endpoint that carries the name, and a hostname is written once.
      'shared-subdomain',
      'tenancy-certificate',
    ]);
    expect(calls).not.toContain('binding');
    expect(calls.some((c) => c.startsWith('create-idp'))).toBe(false);
    expect(marks.map((m) => m.kind)).toContain('ready');
  });

  // Written before the first step that can fail, so a build that dies in the
  // middle leaves a row the reaper can follow to the project and namespace.
  it('records the area before the first step that can fail', async () => {
    const { service, calls } = build();
    await service.provision('c1');

    expect(calls.indexOf('record-area')).toBeLessThan(
      calls.indexOf('ensure-ns'),
    );
  });
});

describe('SandboxTenantService.reap', () => {
  it('deletes everything it made', async () => {
    const { service, calls, marks } = build();
    await service.reap(tenantRow);

    expect(calls).toEqual([
      'delete-ns',
      'list-endpoints',
      'delete-endpoint-resources:ep-1',
      'delete-endpoint:ep-1',
      // The master Secret lives in `flui-system`, so deleting the namespace
      // does not take the tenancy's certificate with it.
      'release-tenancy-certificate',
      'delete-apps',
      // The rows go without the usual teardown, so their images on the
      // instance registry are removed here.
      'forget-images:a1',
      'delete-project:proj-1',
      // The area is the guest's personal project: it goes with them.
      'delete-personal-project:u1',
      'delete-binding:guest-1@try.flui.cloud:u1',
      // Before the user row, and named on its own: `api_keys` has no foreign
      // key to `users`, so without this step every credential the guest minted
      // outlives the person it was issued to.
      'delete-api-keys:u1',
      // The PAT a guest connected, and the copy each connected repository
      // keeps, leave with the person rather than outliving the area.
      'forget-github-tokens:u1',
      'delete-idp:idp-1',
      'delete-user',
    ]);
    expect(marks[0].kind).toBe('expired');
  });

  it('records a failed GitHub token sweep instead of losing it', async () => {
    const { service, marks } = build({ githubTokens: true });
    await service.reap(tenantRow);

    expect(marks[0].kind).toBe('failed');
    expect(marks[0].detail).toContain('github tokens');
  });

  it('records a failed key sweep instead of losing it', async () => {
    const { service, marks } = build({ apiKeys: true });
    await service.reap(tenantRow);

    expect(marks[0].kind).toBe('failed');
    expect(marks[0].detail).toContain('api keys');
  });

  // Rows written before the identity was recorded still have an account behind
  // them; the address is the only handle left, and it must match exactly.
  it('finds the account by address when the row never recorded one', async () => {
    const { service, calls } = build();
    await service.reap({
      ...tenantRow,
      idpUserId: null,
    } as SandboxTenantEntity);

    expect(calls).toContain('list-idp');
    expect(calls).toContain('delete-idp:idp-1');
    expect(calls).not.toContain('delete-idp:idp-other');
  });

  // A failure late in teardown must not stop the rest: the namespace is the only
  // part that costs anything, and it is already gone by then.
  it('carries on past a step that fails and records what it could not finish', async () => {
    const { service, calls, marks } = build({ idp: true });
    await service.reap(tenantRow);

    expect(calls).toContain('delete-apps');
    expect(calls).toContain('delete-binding:guest-1@try.flui.cloud:u1');
    expect(marks[0].kind).toBe('failed');
    expect(marks[0].detail).toContain('idp user');
  });

  /**
   * The local row is the only thing on this side that remembers which
   * identity-provider account belongs to this tenancy. Deleting it after a
   * failed identity delete leaves a real person in the provider that nothing
   * here will ever come back for — a leak with no trace to search by.
   */
  it('keeps the local user when the identity could not be deleted', async () => {
    const { service, calls, marks } = build({ idp: true });
    await service.reap(tenantRow);

    expect(calls).not.toContain('delete-user');
    expect(marks[0].detail).toContain('local user: kept');
  });

  // Reported as a failure, but it is the outcome: nothing to delete. Holding the
  // local row for it would keep a fully-reaped tenancy retrying forever.
  it('treats an identity that is already absent as gone', async () => {
    const { service, calls, marks } = build({ idpMissing: true });
    await service.reap(tenantRow);

    expect(calls).toContain('delete-user');
    expect(JSON.stringify(marks)).not.toContain('local user: kept');
  });

  // A project nothing points at is a "Demo" row that outlives every tenancy that
  // ever had one — the Projects section fills up with the dead.
  it('takes the tenancy\u2019s project with it', async () => {
    const { service, calls } = build({});
    await service.reap(tenantRow);

    expect(calls).toContain('delete-project:proj-1');
    expect(calls.indexOf('delete-apps')).toBeLessThan(
      calls.indexOf('delete-project:proj-1'),
    );
  });

  it('deletes the local user once the identity is really gone', async () => {
    const { service, calls } = build({});
    await service.reap(tenantRow);

    expect(calls).toContain('delete-idp:idp-1');
    expect(calls).toContain('delete-user');
  });

  it('still deletes the identity when the cluster cannot be reached', async () => {
    const { service, calls } = build({ namespace: true });
    await service.reap(tenantRow);

    expect(calls).toContain('delete-idp:idp-1');
    expect(calls).toContain('delete-user');
  });

  it('never reports success when something was left behind', async () => {
    const { service, marks } = build({ namespace: true, apps: true });
    await service.reap(tenantRow);

    expect(marks[0].kind).toBe('failed');
    expect(marks[0].detail).toContain('namespace');
    expect(marks[0].detail).toContain('applications');
  });

  it('keeps the endpoint handle when DNS cleanup fails and retries later', async () => {
    const { service, calls, marks } = build({ endpoint: true });
    await service.reap(tenantRow);

    expect(calls).toContain('delete-endpoint-resources:ep-1');
    expect(calls).not.toContain('delete-endpoint:ep-1');
    expect(calls).toContain('delete-apps');
    expect(marks[0]).toMatchObject({ kind: 'failed' });
    expect(marks[0].detail).toContain('endpoints');
  });
});

/**
 * The seven rows that made this necessary: a tenancy whose cluster had been
 * removed failed on the same missing kubeconfig every minute. There is nothing
 * on the other side to delete — the namespace went with the cluster — so
 * treating it as a failure is what kept them alive.
 */
describe('SandboxTenantService.reap, when the cluster is gone', () => {
  it('finishes instead of failing on a namespace nothing can reach', async () => {
    const { service, marks, calls } = build({ clusterGone: true });

    await service.reap(tenantRow);

    expect(calls).not.toContain('delete-ns');
    expect(marks.map((m) => m.kind)).toContain('expired');
    expect(marks.map((m) => m.kind)).not.toContain('failed');
  });

  // A cluster that is still registered but unreadable is a different sentence:
  // it may work in a minute, so it stays a failure and stays in the sweep.
  it('still fails when the cluster is there and the call does not work', async () => {
    const { service, marks } = build({ namespace: true });

    await service.reap(tenantRow);

    expect(marks.map((m) => m.kind)).toContain('failed');
  });
});

describe('SandboxTenantService.expireNow', () => {
  // Whatever else changes, this must stay the sweep: an area removed some other
  // way leaves the identity-provider account behind.
  it('runs the same teardown the deadline would have run', async () => {
    const { service, calls } = build();

    const after = await service.expireNow(tenantRow);

    expect(calls).toContain('delete-ns');
    expect(calls).toContain('delete-idp:idp-1');
    expect(calls).toContain('delete-binding:guest-1@try.flui.cloud:u1');
    expect(after.state).toBe(SandboxTenantState.EXPIRED);
  });

  it('reports the area as it stands when part of the teardown did not work', async () => {
    const { service } = build({ idp: true });

    const after = await service.expireNow(tenantRow);

    expect(after.state).toBe(SandboxTenantState.FAILED);
  });
});

describe('SandboxTenantService area placement', () => {
  it("builds the area in its project's namespace, the one the guest's apps will land in", async () => {
    const { service, recorded } = build();

    const tenant = await service.provision('c1');

    expect(recorded).toEqual(['p-area-1a2b3c4d']);
    expect(tenant.namespace).toBe('p-area-1a2b3c4d');
    expect(tenant.projectId).toBe('area-project');
  });
});

describe('SandboxTenantService pod security', () => {
  it('enforces the configured Pod Security Standard on every new area', async () => {
    const { service, namespaceLabels } = build();

    await service.provision('c1');

    expect(namespaceLabels[0]).toEqual(
      expect.objectContaining({
        'pod-security.kubernetes.io/enforce': 'baseline',
        'pod-security.kubernetes.io/warn': 'baseline',
      }),
    );
  });
});

describe('SandboxTenantService.sweepExpiredWorkloads', () => {
  // The whole point of two clocks: the machines go, the person keeps the area.
  it('removes what the guest deployed through the same path a person’s own delete takes', async () => {
    const { service, calls } = build();

    const removed = await service.sweepExpiredWorkloads();

    expect(removed).toBe(1);
    expect(calls).toContain('delete-app:a1');
    expect(calls).not.toContain('delete-ns');
  });

  it('reaches every held area, not only the first page of them', async () => {
    const { service, calls } = build();
    const held = Array.from({ length: 450 }, (_, i) => ({
      ...tenantRow,
      id: `t${i}`,
      namespace: `guest-${i}`,
    }));
    const pages: number[] = [];
    (
      service as unknown as {
        reserve: { findClaimed: (l: number, s: number) => Promise<unknown[]> };
      }
    ).reserve.findClaimed = async (limit: number, skip: number) => {
      pages.push(skip);
      return held.slice(skip, skip + limit);
    };

    const removed = await service.sweepExpiredWorkloads();

    expect(pages).toEqual([0, 200, 400]);
    expect(removed).toBe(450);
    expect(calls.filter((c) => c.startsWith('delete-app'))).toHaveLength(450);
  });

  it('does nothing when nobody is holding an area', async () => {
    const { service, calls } = build({ noHeld: true });

    expect(await service.sweepExpiredWorkloads()).toBe(0);
    expect(calls.filter((c) => c.startsWith('delete-app'))).toHaveLength(0);
  });
});

describe('SandboxTenantService taking back an emptied area', () => {
  const NOW = new Date('2026-10-07T12:00:00Z');
  const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
  const area = (over: Partial<SandboxTenantEntity>) =>
    ({
      ...tenantRow,
      idpUserId: null,
      projectId: 'area-project',
      namespace: 'p-area-empty',
      claimedAt: minutesAgo(30),
      ...over,
    }) as SandboxTenantEntity;

  const withHeld = (held: SandboxTenantEntity[]) => {
    const built = build();
    (
      built.service as unknown as {
        reserve: { findClaimed: (l: number, s: number) => Promise<unknown[]> };
      }
    ).reserve.findClaimed = async (_l: number, skip: number) =>
      skip === 0 ? held : [];
    return built;
  };

  it('finds an area that has held nothing for longer than the grace', async () => {
    const empty = area({});
    const { service } = withHeld([
      empty,
      area({ id: 'busy', namespace: 'p-area-busy' }),
      area({ id: 'fresh', claimedAt: minutesAgo(2) }),
      area({ id: 'legacy', projectId: null }),
    ]);

    const found = await service.findEmptyAreas(NOW);

    expect(found.map((a) => a.id)).toEqual([empty.id]);
  });

  it('counts an area whose guest deleted everything as empty, so the space is freed', async () => {
    const cleared = area({ id: 'cleared', namespace: 'p-area-cleared' });
    const { service } = withHeld([cleared]);

    const found = await service.findEmptyAreas(NOW);

    expect(found.map((a) => a.id)).toEqual(['cleared']);
  });

  it('takes back the area and its project without touching the person', async () => {
    const { service, calls, marks } = build();

    await service.reap(area({}));

    expect(calls).toContain('delete-ns');
    expect(calls).toContain('delete-project:area-project');
    expect(calls.some((c) => c.startsWith('delete-binding'))).toBe(false);
    expect(calls.some((c) => c.startsWith('delete-api-keys'))).toBe(false);
    expect(calls.some((c) => c.startsWith('delete-idp'))).toBe(false);
    expect(calls).not.toContain('delete-user');
    expect(calls).not.toContain('list-idp');
    expect(marks[0].kind).toBe('expired');
  });
});

describe('SandboxTenantService and the lifetime of what a guest deploys', () => {
  const HOUR = 3_600_000;
  const NOW = new Date('2026-10-07T12:00:00Z');
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * HOUR);

  const run = async (
    app: { createdAt: Date },
    area: Partial<SandboxTenantEntity>,
  ) => {
    const built = build();
    const internals = built.service as unknown as {
      reserve: { findClaimed: (l: number, s: number) => Promise<unknown[]> };
      applications: { find: () => Promise<unknown[]> };
    };
    internals.reserve.findClaimed = async (_l, skip) =>
      skip === 0
        ? [
            {
              ...tenantRow,
              email: 'mario@example.com',
              expiryWarnedAt: null,
              lastActiveAt: null,
              ...area,
            },
          ]
        : [];
    internals.applications.find = async () => [
      { id: 'a1', slug: 'web', projectId: 'proj-1', ...app },
    ];
    const removed = await built.service.sweepExpiredWorkloads(NOW);
    return { removed, calls: built.calls, marks: built.marks };
  };

  it('removes an application a day after its deploy when its guest did nothing', async () => {
    const { removed } = await run({ createdAt: hoursAgo(25) }, {});
    expect(removed).toBe(1);
  });

  it('keeps it while its guest keeps acting', async () => {
    const { removed } = await run(
      { createdAt: hoursAgo(30) },
      { lastActiveAt: hoursAgo(2) },
    );
    expect(removed).toBe(0);
  });

  it('removes it after the longest lifetime whatever the guest does', async () => {
    const { removed } = await run(
      { createdAt: hoursAgo(73) },
      { lastActiveAt: hoursAgo(1) },
    );
    expect(removed).toBe(1);
  });

  it('warns the guest once, a few hours before', async () => {
    const { calls, marks } = await run({ createdAt: hoursAgo(20) }, {});
    expect(calls).toContain('warn:mario@example.com:web');
    expect(marks.map((m) => m.kind)).toContain('warned');
  });

  it('does not warn again before the guest acts', async () => {
    const { calls } = await run(
      { createdAt: hoursAgo(20) },
      { expiryWarnedAt: hoursAgo(1) },
    );
    expect(calls.some((c) => c.startsWith('warn:'))).toBe(false);
  });

  it('never mails an address the identity provider has not proven', async () => {
    const { calls } = await run(
      { createdAt: hoursAgo(20) },
      { email: 'oidc-123@flui.invalid' },
    );
    expect(calls.some((c) => c.startsWith('warn:'))).toBe(false);
  });
});

describe('SandboxTenantService and idle guest accounts', () => {
  const DAY = 86_400_000;
  const NOW = new Date('2026-10-07T12:00:00Z');
  const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY);

  const withGuests = (
    people: Array<{
      id: string;
      lastSeenAt: Date | null;
      createdAt: Date;
      isAdmin?: boolean;
    }>,
    holding: string[] = [],
  ) => {
    const built = build();
    const internals = built.service as unknown as {
      bindings: { find: () => Promise<unknown[]> };
      users: {
        findOne: (q: { where: { id: string } }) => Promise<unknown>;
        delete: (w: { id: string }) => Promise<void>;
      };
      reserve: { findActiveForUser: (id: string) => Promise<unknown> };
    };
    internals.bindings.find = async () =>
      people.map((p) => ({ principalRef: p.id }));
    internals.users.findOne = async ({ where }) => {
      const p = people.find((x) => x.id === where.id);
      return p
        ? {
            ...p,
            email: `${p.id}@example.com`,
            oidcSub: `sub-${p.id}`,
            isAdmin: !!p.isAdmin,
          }
        : null;
    };
    internals.users.delete = async ({ id }) => {
      built.calls.push(`delete-user:${id}`);
    };
    internals.reserve.findActiveForUser = async (id) =>
      holding.includes(id) ? { id } : null;
    return built;
  };

  it('deletes a guest not seen for a month who holds no area, account and all', async () => {
    const { service, calls } = withGuests(
      [
        { id: 'old', lastSeenAt: daysAgo(31), createdAt: daysAgo(60) },
        { id: 'recent', lastSeenAt: daysAgo(2), createdAt: daysAgo(60) },
        { id: 'busy', lastSeenAt: daysAgo(40), createdAt: daysAgo(60) },
        {
          id: 'boss',
          lastSeenAt: daysAgo(90),
          createdAt: daysAgo(99),
          isAdmin: true,
        },
      ],
      ['busy'],
    );

    expect(await service.deleteIdleGuestAccounts(NOW)).toBe(1);
    expect(calls).toContain('delete-user:old');
    expect(calls).toContain('delete-idp:sub-old');
    expect(calls).toContain('delete-api-keys:old');
    expect(calls.filter((c) => c.startsWith('delete-user:'))).toEqual([
      'delete-user:old',
    ]);
  });

  it('counts from sign-up for a guest never seen since', async () => {
    const { service } = withGuests([
      { id: 'never', lastSeenAt: null, createdAt: daysAgo(45) },
    ]);
    expect(await service.deleteIdleGuestAccounts(NOW)).toBe(1);
  });
});
