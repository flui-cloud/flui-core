import { SandboxScopeService } from './sandbox-scope.service';
import { loadSandboxConfig } from '../sandbox.config';

describe('SandboxScopeService', () => {
  const build = (area: { clusterId: string } | null) =>
    new SandboxScopeService(
      { findOne: jest.fn(async () => area) } as never,
      { find: jest.fn(async () => []) } as never,
      loadSandboxConfig({
        SANDBOX_ENABLED: 'true',
        SANDBOX_CLUSTER_ID: 'demo',
      }),
    );

  it('shows a guest the cluster of their area', async () => {
    const scope = await build({ clusterId: 'c-area' }).resolve('u1', [
      'clusterId',
    ]);
    expect(scope.clusterId).toBe('c-area');
  });

  it('shows a guest with no area yet the cluster their first deploy goes to', async () => {
    const scope = await build(null).resolve('u1', ['clusterId']);
    expect(scope.clusterId).toBe('demo');
  });
});
