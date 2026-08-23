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
      | 'seed'
      | 'endpoint'
      | 'clusterGone',
      boolean
    >
  > = {},
) => {
  const calls: string[] = [];
  const marks: Array<{ kind: string; detail?: string }> = [];

  const reserve = {
    createPending: async () => ({ ...tenantRow, id: 'new' }),
    recordIdentities: async () => calls.push('record-identities'),
    markReady: async () => marks.push({ kind: 'ready' }),
    markExpired: async () => marks.push({ kind: 'expired' }),
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
  const seed = {
    seed: async () => {
      calls.push('seed');
      return 'install-1';
    },
    waitUntilSeeded: async () => {
      calls.push('wait-seed');
      return !breakages.seed;
    },
    groupUnderProject: async () => calls.push('group-project'),
  };
  const history = {
    copyInto: async () => {
      calls.push('copy-history');
      return { copied: true, seconds: 1.7 };
    },
  };
  const k8s = {
    ensureNamespaceExists: async () => calls.push('ensure-ns'),
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
    delete: async () => calls.push('delete-binding'),
  };
  const apiKeys = {
    delete: async (where: { userId: string }) => {
      calls.push(`delete-api-keys:${where.userId}`);
      if (breakages.apiKeys) throw new Error('keys locked');
      return { affected: 2 };
    },
  };
  const applications = {
    find: async () => [{ id: 'a1', projectId: 'proj-1' }],
    delete: async () => {
      calls.push('delete-apps');
      if (breakages.apps) throw new Error('fk violation');
    },
  };
  const projects = {
    remove: async (id: string) => calls.push(`delete-project:${id}`),
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

  const service = new SandboxTenantService(
    reserve as never,
    { recordBuild: () => undefined } as never,
    quota as never,
    seed as never,
    history as never,
    k8s as never,
    encryption as never,
    directory as never,
    config,
    users as never,
    bindings as never,
    apiKeys as never,
    applications as never,
    clusters as never,
    projects as never,
    appEndpoints as never,
    endpointReconciliation as never,
  );
  return { service, calls, marks };
};

describe('SandboxTenantService.provision', () => {
  it('builds identity, grant, namespace and quota before calling it ready', async () => {
    const { service, calls, marks } = build();
    await service.provision('c1');

    expect(calls).toEqual([
      'record-identities',
      'binding',
      'ensure-ns',
      'quota',
      'netpol',
      'noindex',
      'seed',
      'wait-seed',
      // After the seed runs and before anyone can hold the tenancy: the copy
      // is what stops a freshly built area from looking newly born.
      'copy-history',
      'group-project',
    ]);
    expect(marks.map((m) => m.kind)).toContain('ready');
  });

  // The seed alone can run for ten minutes. Anything that breaks in there used
  // to strand the identity-provider account, because the row that named it was
  // only written once the tenancy went ready.
  it('records the identity before the long part, so a failure can still be cleaned up', async () => {
    const { service, calls } = build({ seed: true });

    await expect(service.provision('c1')).rejects.toThrow('not offered');
    expect(calls.indexOf('record-identities')).toBeLessThan(
      calls.indexOf('seed'),
    );
  });

  // A tenancy handed out with an empty namespace breaks the one promise the
  // first screen makes, so a seed that never comes up must not be offered.
  it('refuses to offer a tenancy whose seed never came up', async () => {
    const { service, marks } = build({ seed: true });

    await expect(service.provision('c1')).rejects.toThrow('not offered');
    expect(marks.map((m) => m.kind)).toContain('failed');
    expect(marks.map((m) => m.kind)).not.toContain('ready');
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
      'delete-apps',
      'delete-project:proj-1',
      'delete-binding',
      // Before the user row, and named on its own: `api_keys` has no foreign
      // key to `users`, so without this step every credential the guest minted
      // outlives the person it was issued to.
      'delete-api-keys:u1',
      'delete-idp:idp-1',
      'delete-user',
    ]);
    expect(marks[0].kind).toBe('expired');
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
    expect(calls).toContain('delete-binding');
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
    expect(calls).toContain('delete-binding');
    expect(after.state).toBe(SandboxTenantState.EXPIRED);
  });

  it('reports the area as it stands when part of the teardown did not work', async () => {
    const { service } = build({ idp: true });

    const after = await service.expireNow(tenantRow);

    expect(after.state).toBe(SandboxTenantState.FAILED);
  });
});
