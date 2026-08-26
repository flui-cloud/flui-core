jest.mock('@kubernetes/client-node', () => ({
  PortForward: class {},
  CoreV1Api: class {},
}));
jest.mock('ip-cidr', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: jest.fn() }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ExecutionContext, NotFoundException } from '@nestjs/common';
import { PlatformFoundationGuard } from './platform-foundation.guard';
import { AppOwnershipGuard } from './app-ownership.guard';
import { CONSOLE_TARGET_ABSENT } from '../constants/platform-foundations';
import { ApplicationsRepository } from '../../applications/repositories/applications.repository';
import { CacheConnectionResolver } from '../services/cache-connection.resolver';
import { FulltextConnectionResolver } from '../services/fulltext-connection.resolver';
import { KafkaConnectionResolver } from '../services/kafka-connection.resolver';
import { MessagingConnectionResolver } from '../services/messaging-connection.resolver';
import { ObjectStoreConnectionResolver } from '../services/object-store-connection.resolver';
import { OwnerSecretConnectionResolver } from '../services/owner-secret-connection.resolver';
import { SearchConnectionResolver } from '../services/search-connection.resolver';
import { SecretsConnectionResolver } from '../services/secrets-connection.resolver';
import { KubePortForwardService } from '../services/kube-port-forward.service';
import type { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';

const PLATFORM_POSTGRES = {
  id: 'aaaaaaaa-1111-4222-8333-444444444444',
  slug: 'postgres',
  name: 'PostgreSQL',
  k8sNamespace: 'flui-system',
  clusterId: 'cluster-1',
  labels: { app: 'postgres' },
  env: [],
  userId: null,
};

const TENANT_DB = {
  id: 'bbbbbbbb-1111-4222-8333-444444444444',
  slug: 'postgres-815796',
  name: 'Postgres',
  k8sNamespace: 'user-dawit',
  clusterId: 'cluster-1',
  labels: { 'flui.cloud/db-engine': 'postgres' },
  env: [],
  userId: 'user-a',
};

const ctx = (id: string, user: unknown): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ params: { id }, user }) }),
  }) as unknown as ExecutionContext;

const repoOf = (row: unknown) =>
  ({
    findById: jest.fn(async (id: string) =>
      id === (row as { id: string }).id ? row : null,
    ),
  }) as unknown as ApplicationsRepository;

describe('the guard on the portal door', () => {
  it('answers a foundation as absent to an administrator', async () => {
    const guard = new PlatformFoundationGuard(repoOf(PLATFORM_POSTGRES));
    await expect(
      guard.canActivate(ctx(PLATFORM_POSTGRES.id, { isAdmin: true })),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('answers a foundation as absent even once somebody records an owner on it', async () => {
    // The closure must not be an ownership rule wearing another name: giving the
    // row a userId — the obvious "fix" for a null owner — must change nothing.
    const owned = { ...PLATFORM_POSTGRES, userId: 'user-a' };
    const guard = new PlatformFoundationGuard(repoOf(owned));
    await expect(
      guard.canActivate(ctx(owned.id, { userId: 'user-a', isAdmin: false })),
    ).rejects.toThrow(CONSOLE_TARGET_ABSENT);
  });

  it("lets a tenant's own database through", async () => {
    const guard = new PlatformFoundationGuard(repoOf(TENANT_DB));
    await expect(
      guard.canActivate(ctx(TENANT_DB.id, { userId: 'user-a' })),
    ).resolves.toBe(true);
  });

  it('defers a missing row to the ownership guard, so the two read alike', async () => {
    const guard = new PlatformFoundationGuard(repoOf(TENANT_DB));
    await expect(
      guard.canActivate(ctx('no-such-id', { userId: 'user-a' })),
    ).resolves.toBe(true);
  });
});

/**
 * Every console door, present and future. The guard is one line on a class, and
 * a line is exactly the kind of thing a new controller is written without — the
 * hole closed this morning was born that way.
 */
describe('every console controller carries the fence, ahead of ownership', () => {
  const dir = path.join(__dirname, '..', 'controllers');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.controller.ts'));

  const perApp = files.filter((f) => {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    return /@Controller\(\s*'[^']*applications\/:id/.test(src);
  });

  it('finds the console controllers it is meant to be pinning', () => {
    expect(perApp.length).toBeGreaterThanOrEqual(13);
  });

  it.each(perApp)('%s names PlatformFoundationGuard first', (file) => {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    const useGuards = /@UseGuards\(([^)]*)\)/.exec(src);
    expect(useGuards).not.toBeNull();
    const listed = (useGuards as RegExpExecArray)[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    expect(listed).toContain('PlatformFoundationGuard');
    expect(listed.indexOf('PlatformFoundationGuard')).toBeLessThan(
      listed.indexOf('AppOwnershipGuard'),
    );
  });

  it('keeps the ownership guard alongside it — this replaces nothing', () => {
    expect(AppOwnershipGuard).toBeDefined();
  });
});

/**
 * The second depth. The controller guard reads `:id`; the object-store share
 * link carries its appId in a signed token and never touches that param, so a
 * fence that lived only on the door would have a road around it.
 */
describe('every console connection resolver refuses a foundation', () => {
  const resolvers = [
    ['cache', CacheConnectionResolver],
    ['fulltext', FulltextConnectionResolver],
    ['kafka', KafkaConnectionResolver],
    ['messaging', MessagingConnectionResolver],
    ['object-store', ObjectStoreConnectionResolver],
    ['owner-secret (sql/kv/document)', OwnerSecretConnectionResolver],
    ['search', SearchConnectionResolver],
    ['secrets', SecretsConnectionResolver],
  ] as const;

  it('covers every *-connection.resolver.ts on disk', () => {
    const dir = path.join(__dirname, '..', 'services');
    const onDisk = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('connection.resolver.ts'));
    expect(onDisk).toHaveLength(resolvers.length);
  });

  it.each(resolvers)('%s answers absence', async (_label, Resolver) => {
    const resolver = new (Resolver as new (...args: unknown[]) => {
      resolve(input: unknown): Promise<unknown>;
    })(repoOf(PLATFORM_POSTGRES), {}, {});
    await expect(
      resolver.resolve({
        appId: PLATFORM_POSTGRES.id,
        dbInstallId: PLATFORM_POSTGRES.id,
        fluiUserId: 'user-a',
      }),
    ).rejects.toThrow(CONSOLE_TARGET_ABSENT);
  });
});

/**
 * The third depth, and the one that reads no name at all: whatever the row is
 * called after somebody renames it, a tunnel onto the foundation's port inside a
 * platform namespace does not open.
 */
describe('the transport refuses a foundation whatever asked for it', () => {
  const kube = {
    makeKubeConfig: () => ({
      makeApiClient: () => ({
        listNamespacedPod: async () => ({
          items: [{ metadata: { name: 'p' }, status: { phase: 'Running' } }],
        }),
      }),
    }),
  } as unknown as KubernetesService;

  it('refuses a tunnel to the platform database', async () => {
    const svc = new KubePortForwardService(kube);
    await expect(svc.open('kc', 'flui-system', 'app=x', 5432)).rejects.toThrow(
      CONSOLE_TARGET_ABSENT,
    );
    await svc.onModuleDestroy();
  });

  it('opens a tunnel into a tenant namespace on the same port', async () => {
    const svc = new KubePortForwardService(kube);
    const tunnel = await svc.open('kc', 'user-dawit', 'app=x', 5432);
    expect(tunnel.localPort).toBeGreaterThan(0);
    await tunnel.dispose();
    await svc.onModuleDestroy();
  });
});
