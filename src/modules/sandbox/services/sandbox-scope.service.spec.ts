import { SandboxScopeService } from './sandbox-scope.service';
import { loadSandboxConfig } from '../sandbox.config';

describe('SandboxScopeService', () => {
  const build = (
    area: { clusterId: string } | null,
    find: jest.Mock = jest.fn(async () => []),
  ) =>
    new SandboxScopeService(
      { findOne: jest.fn(async () => area) } as never,
      { find } as never,
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

  it('counts the projects of the showcase among those a guest may see', async () => {
    const find = jest.fn(async () => [
      { id: 'mine', projectId: 'p-own' },
      { id: 'shown', projectId: 'p-showcase' },
    ]);
    const scope = await build(null, find).resolve('u1', ['projectIds']);
    expect(scope.projectIds).toEqual(new Set(['p-own', 'p-showcase']));
    const [{ where }] = find.mock.calls[0] as unknown as [
      { where: Array<Record<string, unknown>> },
    ];
    expect(where).toHaveLength(2);
    expect(where[0]).toMatchObject({ userId: 'u1' });
    expect(where[1]).toHaveProperty('tags');
  });
});
