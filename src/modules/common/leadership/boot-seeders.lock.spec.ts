jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: jest.fn() }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));
jest.mock('./advisory-lock', () =>
  jest.requireActual('./testing/fake-advisory-locks'),
);

import { resetFakeLocks, takenLocks } from './testing/fake-advisory-locks';
import { BootstrapSeeder } from '../../auth/seeders/bootstrap.seeder';
import { AdminSeeder } from '../../auth/seeders/admin.seeder';
import { OidcBootstrapSeeder } from '../../auth/seeders/oidc-bootstrap.seeder';
import { GitHubIntegrationConfigService } from '../../repositories/services/github-integration-config.service';
import { CatalogSeederService } from '../../catalog/services/catalog-seeder.service';

type Seeder = { hook(): Promise<void> };

const cases: Array<{
  name: string;
  lock: string;
  make(work: () => Promise<void>): Seeder;
}> = [
  {
    name: 'the bootstrap seeder',
    lock: 'boot-seed:bootstrap',
    make: (work) => {
      const s = Object.create(BootstrapSeeder.prototype);
      Object.assign(s, { dataSource: {}, seed: work });
      return { hook: () => s.onModuleInit() };
    },
  },
  {
    name: 'the first administrator',
    lock: 'boot-seed:admin',
    make: (work) => {
      const s = Object.create(AdminSeeder.prototype);
      Object.assign(s, { dataSource: {}, seed: work });
      return { hook: () => s.onModuleInit() };
    },
  },
  {
    name: 'the OIDC bootstrap',
    lock: 'boot-seed:oidc',
    make: (work) => {
      const s = Object.create(OidcBootstrapSeeder.prototype);
      Object.assign(s, { dataSource: {}, seed: work });
      return { hook: () => s.onApplicationBootstrap() };
    },
  },
  {
    name: 'the GitHub integration import',
    lock: 'boot-seed:github-integration-config',
    make: (work) => {
      const s = Object.create(GitHubIntegrationConfigService.prototype);
      Object.assign(s, { dataSource: {}, migrateFromEnvIfNeeded: work });
      return { hook: () => s.onModuleInit() };
    },
  },
  {
    name: 'the catalog seed',
    lock: 'boot-seed:catalog',
    make: (work) => {
      const s = Object.create(CatalogSeederService.prototype);
      Object.assign(s, { dataSource: {}, seed: work });
      return { hook: () => s.onApplicationBootstrap() };
    },
  },
];

describe('first-boot seeding when two copies of the API start together', () => {
  const saved = process.env.AUTH_MODE;
  beforeEach(() => resetFakeLocks());
  afterEach(() => {
    if (saved === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = saved;
  });

  it.each(cases)('runs $name one copy at a time', async ({ lock, make }) => {
    process.env.AUTH_MODE = lock === 'boot-seed:admin' ? 'local' : 'oidc';
    const order: string[] = [];
    let release!: () => void;
    const first = make(async () => {
      order.push('first:start');
      await new Promise<void>((r) => (release = r));
      order.push('first:end');
    });
    const second = make(async () => {
      order.push('second');
    });

    const a = first.hook();
    const b = second.hook();
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(['first:start']);
    release();
    await Promise.all([a, b]);

    expect(order).toEqual(['first:start', 'first:end', 'second']);
    expect(takenLocks).toEqual([lock, lock]);
  });
});
