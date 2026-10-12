jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { DemoOrchestratorService } from './demo-orchestrator.service';
import { DemoLoopState } from '../enums/demo.enum';
import { FullMigrationStatus } from '../../full-migration/enums/full-migration.enum';

function setup(cfg: Record<string, unknown>, fm: Record<string, unknown>) {
  const config: any = {
    enabled: true,
    activeFullMigrationId: 'fm-1',
    drainMinutes: 0,
    cycleCount: 0,
    strikes: 0,
    ...cfg,
  };
  const state = {
    get: jest.fn(async () => config),
    patch: jest.fn(async (p: any) => Object.assign(config, p)),
  };
  const fullMig = {
    findById: jest.fn(async () => ({ id: 'fm-1', ...fm })),
    destroySource: jest.fn(async () => undefined),
  };
  const service = new DemoOrchestratorService(
    state as any,
    { emit: jest.fn() } as any,
    fullMig as any,
    {} as any,
    {} as any,
  );
  return { service, config, fullMig };
}

describe('the demo loop and the migration bridge', () => {
  it('starts draining once the migration serves from the destination through the bridge', async () => {
    const { service, config } = setup(
      { state: DemoLoopState.MIGRATING },
      { status: FullMigrationStatus.BRIDGING, targetClusterId: 'dst' },
    );

    await service.tick();

    expect(config.state).toBe(DemoLoopState.DRAINING);
    expect(config.currentClusterId).toBe('dst');
  });

  it('closes the bridge when its drain window ends', async () => {
    const { service, fullMig } = setup(
      { state: DemoLoopState.DRAINING, drainStartedAt: new Date(0) },
      {},
    );

    await service.tick();

    expect(fullMig.destroySource).toHaveBeenCalledWith('fm-1', {
      closeBridge: true,
    });
  });
});
