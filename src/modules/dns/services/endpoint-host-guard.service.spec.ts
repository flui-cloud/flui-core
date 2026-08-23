// Pulled in transitively and ship ESM that jest won't parse; unused on this path.
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));

import { ConflictException, ForbiddenException } from '@nestjs/common';
import {
  EndpointHostGuardService,
  hostsInMatch,
} from './endpoint-host-guard.service';
import { hostsOverlap, isDirectChildOf } from '../utils/host-claim.util';

const CLUSTER = {
  id: 'cluster-1',
  name: 'control-cluster',
  kubeconfigEncrypted: 'enc',
} as never;

interface Served {
  ingresses?: Record<string, any>[];
  ingressRoutes?: Record<string, any>[];
  throws?: boolean;
}

function build(opts: { sandbox: boolean } & Served) {
  const listCrdResources = jest.fn((_kc, kind: string) => {
    if (opts.throws) return Promise.reject(new Error('cluster unreachable'));
    return Promise.resolve(
      kind === 'Ingress' ? (opts.ingresses ?? []) : (opts.ingressRoutes ?? []),
    );
  });
  const service = new EndpointHostGuardService(
    { exists: jest.fn().mockResolvedValue(opts.sandbox) } as never,
    {
      find: jest
        .fn()
        .mockResolvedValue([{ dnsZone: { zoneName: 'dawit.blog' } }]),
    } as never,
    {
      listCrdResources,
      patchKubeconfigServer: jest.fn().mockReturnValue('kubeconfig'),
    } as never,
    { decrypt: jest.fn().mockReturnValue('kubeconfig') } as never,
  );
  return { service, listCrdResources };
}

const ingress = (namespace: string, name: string, ...hosts: string[]) => ({
  metadata: { namespace, name },
  spec: { rules: hosts.map((host) => ({ host })) },
});

describe('EndpointHostGuardService — a sandbox tenancy', () => {
  it('refuses a domain nobody on this instance owns', async () => {
    const { service } = build({ sandbox: true });

    await expect(
      service.assertClaimable(CLUSTER, 'user-guest-a', 'proof.example.com'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows a name directly under the subdomain its cluster serves', async () => {
    const { service } = build({ sandbox: true });

    await expect(
      service.assertClaimable(
        CLUSTER,
        'user-guest-a',
        'mine.control-cluster.dawit.blog',
      ),
    ).resolves.toBeUndefined();
  });

  it.each([
    // One label, because the wildcard certificate in front of it reaches one.
    ['a name two labels deep', 'a.b.control-cluster.dawit.blog'],
    // Syntactically one label under the subdomain, so the direct-child rule
    // alone would have let it through — and it is every name not yet taken.
    [
      'a wildcard even inside its own subdomain',
      '*.control-cluster.dawit.blog',
    ],
    ['the subdomain itself', 'control-cluster.dawit.blog'],
  ])('refuses %s', async (_case, host) => {
    const { service } = build({ sandbox: true });

    await expect(
      service.assertClaimable(CLUSTER, 'user-guest-a', host),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('EndpointHostGuardService — everybody', () => {
  it('refuses a host another namespace already declares', async () => {
    const { service } = build({
      sandbox: false,
      ingresses: [
        ingress('user-guest-b', 'theirs', 'taken.control-cluster.dawit.blog'),
      ],
    });

    await expect(
      service.assertClaimable(
        CLUSTER,
        'user-guest-a',
        'taken.control-cluster.dawit.blog',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('allows a host only this namespace declares', async () => {
    const { service } = build({
      sandbox: false,
      ingresses: [
        ingress('user-guest-a', 'mine', 'mine.control-cluster.dawit.blog'),
      ],
    });

    await expect(
      service.assertClaimable(
        CLUSTER,
        'user-guest-a',
        'mine.control-cluster.dawit.blog',
      ),
    ).resolves.toBeUndefined();
  });

  /**
   * The instance's own API and dashboard are Traefik IngressRoutes and have no
   * row in `app_endpoints` — which is exactly why the table is not the source.
   */
  it('refuses a host an IngressRoute serves', async () => {
    const { service } = build({
      sandbox: false,
      ingressRoutes: [
        {
          metadata: { namespace: 'flui-system', name: 'flui-api' },
          spec: { routes: [{ match: 'Host(`api.example.test`)' }] },
        },
      ],
    });

    await expect(
      service.assertClaimable(CLUSTER, 'user-guest-a', 'api.example.test'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses a wildcard that would swallow another namespace', async () => {
    const { service } = build({
      sandbox: false,
      ingresses: [
        ingress('user-guest-b', 'theirs', 'theirs.control-cluster.dawit.blog'),
      ],
    });

    await expect(
      service.assertClaimable(
        CLUSTER,
        'user-guest-a',
        '*.control-cluster.dawit.blog',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses a host an existing wildcard already answers for', async () => {
    const { service } = build({
      sandbox: false,
      ingresses: [ingress('flui-system', 'catch-all', '*.example.test')],
    });

    await expect(
      service.assertClaimable(CLUSTER, 'user-dawit', 'anything.example.test'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  /** "We did not manage to look" must never be answered as "nothing is there". */
  it('refuses the claim when the cluster cannot be read', async () => {
    const { service } = build({ sandbox: false, throws: true });

    await expect(
      service.assertClaimable(CLUSTER, 'user-dawit', 'x.example.test'),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('host matching', () => {
  it('reads every host out of a Traefik rule', () => {
    expect(hostsInMatch('Host(`a.test`) || Host(`b.test`, `c.test`)')).toEqual([
      'a.test',
      'b.test',
      'c.test',
    ]);
  });

  it('treats a wildcard as one label and no more', () => {
    expect(hostsOverlap('*.x.test', 'a.x.test')).toBe(true);
    expect(hostsOverlap('*.x.test', 'b.a.x.test')).toBe(false);
    expect(hostsOverlap('*.x.test', 'x.test')).toBe(false);
  });

  it('ignores case and a trailing dot', () => {
    expect(hostsOverlap('A.X.test.', 'a.x.test')).toBe(true);
  });

  it('knows a direct child from a deeper one', () => {
    expect(isDirectChildOf('a.x.test', 'x.test')).toBe(true);
    expect(isDirectChildOf('b.a.x.test', 'x.test')).toBe(false);
    expect(isDirectChildOf('x.test', 'x.test')).toBe(false);
  });
});
