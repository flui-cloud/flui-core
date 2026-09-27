jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { CatalogInstallProcessor } from './catalog-install.processor';

/**
 * Nextcloud's database keeps its data in a volume named `db-data`. A shipper
 * that mounted a volume called `data` described a pod the cluster refuses, so
 * every Nextcloud installed with the shipper enabled would never start.
 */
describe('binlog shipper volume', () => {
  const companions = (volumes: Array<{ name: string; mountPath: string }>) =>
    (
      CatalogInstallProcessor.prototype as unknown as {
        continuousBackupCompanions: (e: string, v: unknown) => any;
      }
    ).continuousBackupCompanions.call(null, 'mariadb', volumes);

  const previous = process.env.MARIADB_SHIPPER_IMAGE;
  beforeAll(() => {
    process.env.MARIADB_SHIPPER_IMAGE = 'ghcr.io/flui-cloud/mariadb-shipper:11';
  });
  afterAll(() => {
    process.env.MARIADB_SHIPPER_IMAGE = previous;
  });

  it("mounts the database's own data volume, whatever it is called", () => {
    const c = companions([{ name: 'db-data', mountPath: '/var/lib/mysql' }]);
    const mounted = [
      ...c.initContainers[0].mounts,
      ...c.sidecars[0].mounts,
    ].filter((m: any) => m.mountPath === '/var/lib/mysql');
    expect(mounted.map((m: any) => m.name)).toEqual(['db-data', 'db-data']);
  });

  it('attaches nothing when no volume holds the data directory', () => {
    expect(companions([{ name: 'cache', mountPath: '/tmp' }])).toBeUndefined();
  });
});
