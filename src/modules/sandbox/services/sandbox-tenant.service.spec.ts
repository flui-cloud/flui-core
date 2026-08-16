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
    Record<'namespace' | 'idp' | 'apps' | 'seed', boolean>
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
  const applications = {
    delete: async () => {
      calls.push('delete-apps');
      if (breakages.apps) throw new Error('fk violation');
    },
  };
  const clusters = {
    findOne: async () => ({ id: 'c1', kubeconfigEncrypted: 'enc' }),
  };

  const service = new SandboxTenantService(
    reserve as never,
    quota as never,
    seed as never,
    k8s as never,
    encryption as never,
    directory as never,
    config,
    users as never,
    bindings as never,
    applications as never,
    clusters as never,
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
      'delete-apps',
      'delete-binding',
      'delete-idp:idp-1',
      'delete-user',
    ]);
    expect(marks[0].kind).toBe('expired');
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

    expect(calls).toContain('delete-user');
    expect(marks[0].kind).toBe('failed');
    expect(marks[0].detail).toContain('idp user');
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
});
