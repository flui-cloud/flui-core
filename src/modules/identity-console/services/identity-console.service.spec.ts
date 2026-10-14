jest.mock('@kubernetes/client-node', () => ({}));

import {
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { IdentityConsoleService } from './identity-console.service';
import { IdentityConsoleStateEntity } from '../entities/identity-console-state.entity';

const NOW = new Date('2026-10-14T12:00:00Z');
const ADMIN = { userId: 'u-1', email: 'admin@example.com', kind: 'user' };

function build(opts: { applyFails?: unknown; existingHash?: string } = {}) {
  let row: IdentityConsoleStateEntity | null = null;
  const states = {
    findOne: jest.fn(async () => (row ? { ...row } : null)),
    create: jest.fn((v) => ({ ...v })),
    save: jest.fn(async (v) => {
      row = { ...v };
      return { ...v };
    }),
    update: jest.fn(async (where, patch) => {
      if (
        row &&
        (!('openUntil' in where) ||
          row.openUntil?.getTime() === (where.openUntil as Date).getTime())
      ) {
        row = { ...row, ...patch };
        return { affected: 1 };
      }
      return { affected: 0 };
    }),
    insert: jest.fn(async (v) => {
      row = { ...v };
    }),
  };
  const resources: Record<string, unknown> = {
    'IngressRoute/zitadel': {
      spec: { routes: [{ match: 'Host(`auth-203-0-113-10.nip.io`)' }] },
    },
  };
  const kubernetes = {
    patchKubeconfigServer: jest.fn((k: string) => k),
    getResource: jest.fn(async (_k, kind: string, name: string) => {
      const found = resources[`${kind}/${name}`];
      if (found) return found;
      if (opts.existingHash && name.startsWith('identity-console-gate')) {
        return {
          metadata: {
            annotations: { 'flui.cloud/gate-hash': opts.existingHash },
          },
        };
      }
      return null;
    }),
    applyManifest: jest.fn(async () => {
      if (opts.applyFails) throw opts.applyFails;
      return [];
    }),
    deleteResource: jest.fn(async () => undefined),
  };
  const audit = { record: jest.fn(async () => undefined) };
  const service = new IdentityConsoleService(
    states as never,
    {
      findOne: jest.fn(async () => ({
        id: 'c-1',
        kubeconfigEncrypted: 'enc',
      })),
    } as never,
    {
      findOne: jest.fn(async () => ({
        id: 'app-z',
        k8sNamespace: 'flui-system',
      })),
    } as never,
    { find: jest.fn(async () => [{ fqdn: 'auth.example.com' }]) } as never,
    kubernetes as never,
    { decrypt: jest.fn(() => 'kubeconfig') } as never,
    audit as never,
  );
  return {
    service,
    kubernetes,
    audit,
    states,
    row: () => row,
    setRow: (patch: Partial<IdentityConsoleStateEntity>) => {
      row = { ...(row as IdentityConsoleStateEntity), ...patch };
    },
  };
}

describe('IdentityConsoleService', () => {
  const OLD = {
    issuer: process.env.OIDC_ISSUER,
    frontend: process.env.FRONTEND_URL,
    dashboard: process.env.DASHBOARD_URL,
  };
  beforeEach(() => {
    process.env.OIDC_ISSUER = 'https://auth.example.com';
    process.env.FRONTEND_URL = 'https://console.example.com';
    delete process.env.DASHBOARD_URL;
  });
  afterAll(() => {
    process.env.OIDC_ISSUER = OLD.issuer;
    process.env.FRONTEND_URL = OLD.frontend;
    process.env.DASHBOARD_URL = OLD.dashboard;
  });

  it('sends console visitors to the dashboard Flui is configured with', async () => {
    const { service, kubernetes } = build();
    await service.reconcile(NOW);
    const applied = (
      kubernetes.applyManifest.mock.calls[0] as unknown[]
    )[1] as string;
    expect(applied).toContain('"replacement":"https://console.example.com/"');
    expect(applied).toContain(
      '"middlewares":[{"name":"identity-console-gate"},{"name":"identity-console-gate-refuse"}]',
    );
    await expect(service.status(NOW)).resolves.toMatchObject({
      state: 'closed',
      redirectTo: 'https://console.example.com/',
    });
  });

  it('falls back to 403 when no usable dashboard address is known', async () => {
    process.env.FRONTEND_URL = 'http://localhost:4200';
    const { service, kubernetes } = build();
    await service.reconcile(NOW);
    const applied = (
      kubernetes.applyManifest.mock.calls[0] as unknown[]
    )[1] as string;
    expect(applied).toContain('ipAllowList');
    expect(applied).not.toContain('redirectRegex');
    await expect(service.status(NOW)).resolves.toMatchObject({
      redirectTo: null,
    });
  });

  it('closes an installation that never had a window, on every name the provider answers on', async () => {
    const { service, kubernetes } = build();
    const row = await service.reconcile(NOW);
    expect(row.appliedState).toBe('closed');
    expect(row.appliedHosts).toEqual([
      'auth-203-0-113-10.nip.io',
      'auth.example.com',
    ]);
    const applied = (
      kubernetes.applyManifest.mock.calls[0] as unknown[]
    )[1] as string;
    expect(applied).toContain('identity-console-gate');
    expect(applied).toContain('PathPrefix(`/ui/console`)');
    await expect(service.status(NOW)).resolves.toMatchObject({
      state: 'closed',
      enforced: true,
      openUntil: null,
    });
  });

  it('leaves an unchanged refusal alone', async () => {
    const first = build();
    await first.service.reconcile(NOW);
    const hash = JSON.parse(
      (
        (first.kubernetes.applyManifest.mock.calls[0] as unknown[])[1] as string
      ).split('\n---\n')[0],
    ).metadata.annotations['flui.cloud/gate-hash'];
    const again = build({ existingHash: hash });
    await again.service.reconcile(NOW);
    expect(again.kubernetes.applyManifest).not.toHaveBeenCalled();
  });

  it('opens for the asked minutes, removes the refusal and audits who and why', async () => {
    const { service, kubernetes, audit } = build();
    const status = await service.open(ADMIN, 30, '  fix org policy ', NOW);
    expect(status).toMatchObject({
      state: 'open',
      openUntil: '2026-10-14T12:30:00.000Z',
      openedBy: 'admin@example.com',
      reason: 'fix org policy',
      enforced: true,
    });
    expect(kubernetes.deleteResource).toHaveBeenCalledTimes(4);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'identity console opened',
        email: 'admin@example.com',
        permission: 'iam:manage-users',
        target: {
          until: '2026-10-14T12:30:00.000Z',
          minutes: '30',
          reason: 'fix org policy',
        },
      }),
    );
  });

  it('defaults to 60 minutes and never exceeds the maximum', async () => {
    const a = build();
    await expect(
      a.service.open(ADMIN, undefined, 'why', NOW),
    ).resolves.toMatchObject({
      openUntil: '2026-10-14T13:00:00.000Z',
    });
    const b = build();
    await expect(
      b.service.open(ADMIN, 10_000, 'why', NOW),
    ).resolves.toMatchObject({
      openUntil: '2026-10-14T16:00:00.000Z',
    });
  });

  it('refuses an agent, whatever permission its credential carries', async () => {
    const { service, states } = build();
    await expect(
      service.open({ kind: 'agent', keyId: 'k-1' }, 60, 'why', NOW),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(states.save).not.toHaveBeenCalled();
  });

  it('closes by itself at the end of the window, once, and audits it as the system', async () => {
    const { service, audit, kubernetes } = build();
    await service.open(ADMIN, 5, 'quick look', NOW);
    audit.record.mockClear();
    kubernetes.applyManifest.mockClear();

    const later = new Date(NOW.getTime() + 5 * 60_000);
    const row = await service.reconcile(later);
    expect(row.openUntil).toBeNull();
    expect(row.appliedState).toBe('closed');
    expect(kubernetes.applyManifest).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'identity console closed',
        actorKind: 'system',
        permission: null,
        target: expect.objectContaining({
          cause: 'expired',
          openedBy: 'admin@example.com',
        }),
      }),
    );

    await service.reconcile(new Date(later.getTime() + 60_000));
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('closes on demand and audits it', async () => {
    const { service, audit } = build();
    await service.open(ADMIN, 60, 'why', NOW);
    const status = await service.close(ADMIN, new Date(NOW.getTime() + 60_000));
    expect(status.state).toBe('closed');
    expect(audit.record).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'identity console closed',
        target: { cause: 'manual', wasOpen: 'true' },
      }),
    );
  });

  it('keeps a short cause of the failure, reports not enforced, and says so to the caller', async () => {
    const { service } = build({
      applyFails: new Error(
        'connect ECONNREFUSED 10.0.0.1:6443 {"raw":"body"}',
      ),
    });
    await expect(service.close(ADMIN, NOW)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(service.status(NOW)).resolves.toMatchObject({
      state: 'closed',
      enforced: false,
      lastError: 'The cluster could not be reached',
    });
  });

  it('names the HTTP status the cluster answered, not its message', async () => {
    const refused = Object.assign(new Error('forbidden: User "x" cannot'), {
      code: 403,
    });
    const { service } = build({ applyFails: refused });
    const row = await service.reconcile(NOW);
    expect(row.lastError).toBe('The cluster refused the change (HTTP 403)');
  });

  it('keeps the console closed when it is closed elsewhere while a reconcile is opening it', async () => {
    const { service, kubernetes, setRow, row } = build();
    await service.open(ADMIN, 60, 'why', NOW);
    kubernetes.applyManifest.mockClear();
    kubernetes.deleteResource.mockImplementationOnce(async () => {
      setRow({ openUntil: null, closedAt: NOW });
    });

    const result = await service.reconcile(NOW);

    expect(kubernetes.applyManifest).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ openUntil: null, appliedState: 'closed' });
    expect(row()?.openUntil).toBeNull();
  });

  it('never writes the window back from a stale read', async () => {
    const { service, states } = build();
    await service.open(ADMIN, 60, 'why', NOW);
    states.save.mockClear();
    await service.reconcile(NOW);
    expect(states.save).not.toHaveBeenCalled();
    for (const [, patch] of states.update.mock.calls as unknown as Array<
      [unknown, Record<string, unknown>]
    >) {
      expect(Object.keys(patch)).not.toContain('openUntil');
    }
  });
});
