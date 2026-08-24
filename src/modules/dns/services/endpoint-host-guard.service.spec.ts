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
  /**
   * The subdomains this tenancy has a *valid* certificate for. Empty is every
   * tenancy today, and every new one until its own certificate lands.
   */
  ownSubdomains?: string[];
  sharedSubdomains?: string[];
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
    {
      activeSubdomains: jest.fn().mockResolvedValue(opts.ownSubdomains ?? []),
    } as never,
    {
      activeSubdomains: jest
        .fn()
        .mockResolvedValue(opts.sharedSubdomains ?? []),
    } as never,
  );
  return { service, listCrdResources };
}

describe('EndpointHostGuardService — the installation-wide sandbox subdomain', () => {
  const SHARED = ['demo.dawit.blog'];

  it('lets a guest name a host directly under it', async () => {
    const { service } = build({ sandbox: true, sharedSubdomains: SHARED });

    await expect(
      service.assertClaimable(CLUSTER, 'user-guest-a', 'proof.demo.dawit.blog'),
    ).resolves.toBeUndefined();
  });

  /**
   * Once the tenancy has somewhere of its own, the cluster-wide space stops
   * being available to it — that space is where the instance's own
   * applications live.
   */
  it('stops it reaching back into the cluster-wide space', async () => {
    const { service } = build({ sandbox: true, sharedSubdomains: SHARED });

    await expect(
      service.assertClaimable(
        CLUSTER,
        'user-guest-a',
        'proof.control-cluster.dawit.blog',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  /** One label under, and no deeper: that is all the single wildcard covers. */
  it('refuses a name two labels under it', async () => {
    const { service } = build({ sandbox: true, sharedSubdomains: SHARED });

    await expect(
      service.assertClaimable(CLUSTER, 'user-guest-a', 'a.b.demo.dawit.blog'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses the wildcard itself, which is every name at once', async () => {
    const { service } = build({ sandbox: true, sharedSubdomains: SHARED });

    await expect(
      service.assertClaimable(CLUSTER, 'user-guest-a', '*.demo.dawit.blog'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

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

/**
 * Once `*.<tenancy>.<cluster>.<zone>` is issued and valid, the tenancy's space
 * *is* that subdomain — and the shared one stops being available to it. The
 * rule gets narrower as certificates land; it never gets wider.
 */
describe('EndpointHostGuardService — a tenancy with a subdomain of its own', () => {
  const OWN = ['guest-a.control-cluster.dawit.blog'];

  it('allows a name directly under its own subdomain', async () => {
    const { service } = build({ sandbox: true, ownSubdomains: OWN });

    await expect(
      service.assertClaimable(
        CLUSTER,
        'user-guest-a',
        'mine.guest-a.control-cluster.dawit.blog',
      ),
    ).resolves.toBeUndefined();
  });

  it.each([
    // The name it could have taken before it had somewhere of its own.
    ['the shared cluster subdomain', 'mine.control-cluster.dawit.blog'],
    ["another tenancy's subdomain", 'mine.guest-b.control-cluster.dawit.blog'],
    [
      'a name past what its certificate covers',
      'a.b.guest-a.control-cluster.dawit.blog',
    ],
    [
      'a wildcard over its own subdomain',
      '*.guest-a.control-cluster.dawit.blog',
    ],
    ['the subdomain itself', 'guest-a.control-cluster.dawit.blog'],
  ])('refuses %s', async (_case, host) => {
    const { service } = build({ sandbox: true, ownSubdomains: OWN });

    await expect(
      service.assertClaimable(CLUSTER, 'user-guest-a', host),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('names the subdomain it does own in the refusal', async () => {
    const { service } = build({ sandbox: true, ownSubdomains: OWN });

    await expect(
      service.assertClaimable(CLUSTER, 'user-guest-a', 'proof.example.com'),
    ).rejects.toMatchObject({
      response: {
        code: 'endpoint_host_not_yours',
        message: expect.stringContaining(
          '*.guest-a.control-cluster.dawit.blog',
        ),
      },
    });
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
