jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));

import { RunDbRestoreProcessor } from './run-db-restore.processor';
import { CatalogInstallStatus } from '../../catalog/enums/catalog-install-status.enum';
import { ArtifactLocationState } from '../enums/artifact-location-state.enum';

const SOURCE = 'eef3d3f8-0000-4000-8000-000000000001';
const ENCRYPTED = {
  applicationId: SOURCE,
  repository: {
    objectKeyPrefix: `pgbackrest/${SOURCE}/encrypted/`,
    cipher: 'aes-256-cbc',
  },
};

function run(opts: {
  summary: Record<string, unknown>;
  locationState?: ArtifactLocationState;
  declared?: string[];
  restoreEnv?: Record<string, string>;
}) {
  const artifact = {
    id: 'art-1',
    engine: 'postgres',
    engineClass: 'database',
    engineRef: '20260930-101010F',
    createdAt: new Date('2026-09-30T10:10:10Z'),
    manifestSummary: opts.summary,
    locations: [
      {
        role: 'primary',
        destinationId: 'dest-1',
        state: opts.locationState ?? ArtifactLocationState.AVAILABLE,
      },
    ],
  };
  const buildRestoreEnv = jest
    .fn()
    .mockReturnValue(opts.restoreEnv ?? { FLUI_PG_RESTORE: '1' });
  const info = jest.fn(async () => {
    throw new Error('source pod gone');
  });
  const engine = {
    engine: 'postgres',
    catalogSlug: 'postgresql',
    restoreEnvPrefix: 'FLUI_PG_',
    replaysToEndWithoutTarget: true,
    info,
    buildRestoreEnv,
    identityEnv: jest.fn().mockReturnValue({}),
  };
  const install = {
    id: 'inst-1',
    status: CatalogInstallStatus.RUNNING,
    applicationIds: ['new-app'],
  };
  const installer = {
    install: jest.fn().mockResolvedValue({ install }),
    uninstall: jest.fn(),
  };
  const processor = new RunDbRestoreProcessor(
    { update: jest.fn() } as never,
    { findOne: jest.fn().mockResolvedValue(null), save: jest.fn() } as never,
    { findOne: jest.fn().mockResolvedValue(install), save: jest.fn() } as never,
    { findOne: jest.fn().mockResolvedValue(null) } as never,
    {
      findById: jest.fn().mockResolvedValue({
        id: 'rj-1',
        artifactId: 'art-1',
        userId: 'u1',
        sourceDestinationId: 'dest-1',
        recoveryTargetTime: null,
        targetSelector: {
          newInstall: { name: 'pg-restored', clusterId: 'c1' },
        },
      }),
      update: jest.fn(),
    } as never,
    {
      findArtifact: jest.fn().mockResolvedValue(artifact),
      findLatestDbArtifactForApp: jest.fn().mockResolvedValue(artifact),
    } as never,
    { findById: jest.fn().mockResolvedValue({ id: 'dest-1' }) } as never,
    { forEngine: jest.fn().mockReturnValue(engine) } as never,
    {
      findPublishedBySlug: jest.fn().mockResolvedValue({
        manifest: {
          spec: {
            env: (opts.declared ?? ['FLUI_PG_RESTORE']).map((name) => ({
              name,
            })),
          },
        },
      }),
    } as never,
    installer as never,
  );
  const done = processor.handle({
    data: { restoreJobId: 'rj-1', operationId: 'op-1' },
  } as never);
  return { done, buildRestoreEnv, info, installer };
}

describe('RunDbRestoreProcessor — encrypted and plaintext repositories', () => {
  it('hands the artifact’s own record to the engine, so it picks that repository and its cipher', async () => {
    const r = run({ summary: ENCRYPTED });
    await r.done;
    expect(r.buildRestoreEnv.mock.calls[0][5]).toEqual(ENCRYPTED);
    expect(r.info).toHaveBeenCalledWith(SOURCE, ENCRYPTED);
  });

  it('a plaintext artifact from before encryption is passed as it is', async () => {
    const legacy = { applicationId: SOURCE };
    const r = run({ summary: legacy });
    await r.done;
    expect(r.buildRestoreEnv.mock.calls[0][5]).toEqual(legacy);
  });

  it('refuses a backup whose plaintext copy was removed', async () => {
    const r = run({
      summary: { applicationId: SOURCE },
      locationState: ArtifactLocationState.EXPIRED,
    });
    await expect(r.done).rejects.toThrow(/no longer exists/);
    expect(r.installer.install).not.toHaveBeenCalled();
  });

  it('refuses when the catalog would drop the key variable, instead of failing mid-recovery', async () => {
    const r = run({
      summary: ENCRYPTED,
      restoreEnv: { FLUI_PG_RESTORE: '1', FLUI_PG_CIPHER_PASS: 'k' },
      declared: ['FLUI_PG_RESTORE'],
    });
    await expect(r.done).rejects.toThrow(
      /does not declare FLUI_PG_CIPHER_PASS/,
    );
    expect(r.installer.install).not.toHaveBeenCalled();
  });
});
