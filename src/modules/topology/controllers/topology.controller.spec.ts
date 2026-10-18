jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {},
  KubernetesObjectApi: { makeApiClient: () => ({}) },
  CoreV1Api: class {},
  Exec: class {},
  Metrics: class {},
  PatchStrategy: { MergePatch: 'application/merge-patch+json' },
}));

import { NEVER, firstValueFrom, take } from 'rxjs';
import { TopologyController } from './topology.controller';
import { SANDBOX_GUEST_REQUEST } from '../../sandbox/guards/sandbox-fence.guard';
import { WORLD_CLUSTERS } from '../../sandbox/stand-in/sandbox-world-topology-data';

function make() {
  const events = {
    snapshot: jest.fn(async () => ({ real: true })),
    changes$: NEVER,
  };
  const scope = {
    scope: jest.fn(async () => ({ scoped: true })),
    scopeStream: jest.fn(() => NEVER),
  };
  return {
    controller: new TopologyController(
      events as never,
      scope as never,
      {
        isMockMode: () => false,
      } as never,
    ),
    events,
    scope,
  };
}

const user = { userId: 'u1' };

describe('TopologyController', () => {
  it('answers a guest from the example world and never reads the real one', async () => {
    const { controller, events, scope } = make();
    const out = await controller.getTopology({
      user,
      [SANDBOX_GUEST_REQUEST]: { userId: 'u1' },
    } as never);
    expect(out.version).toBe('2');
    expect(out.clusters.map((c) => c.id)).toEqual(
      WORLD_CLUSTERS.map((c) => c.id),
    );
    expect(events.snapshot).not.toHaveBeenCalled();
    expect(scope.scope).not.toHaveBeenCalled();
  });

  it('narrows the real snapshot to the caller', async () => {
    const { controller, scope } = make();
    const out = await controller.getTopology({ user } as never);
    expect(out).toEqual({ scoped: true });
    expect(scope.scope).toHaveBeenCalledWith(user, { real: true }, false);
  });

  it('passes a request for platform apps on to the scope', async () => {
    const { controller, scope } = make();
    await controller.getTopology({ user } as never, '1');
    expect(scope.scope).toHaveBeenCalledWith(user, { real: true }, true);
  });

  it('shows a guest the example platform apps only on request', async () => {
    const { controller } = make();
    const guest = { user, [SANDBOX_GUEST_REQUEST]: { userId: 'u1' } } as never;
    const plain = await controller.getTopology(guest);
    const all = await controller.getTopology(guest, '1');
    expect(plain.apps.some((a) => a.kind === 'system')).toBe(false);
    expect(all.apps.some((a) => a.kind === 'system')).toBe(true);
    expect(all.apps.length).toBeGreaterThan(plain.apps.length);
  });

  it('streams the example world to a guest, as type and data', async () => {
    const { controller, scope } = make();
    jest.useFakeTimers();
    const first = firstValueFrom(
      controller
        .stream({ user, [SANDBOX_GUEST_REQUEST]: {} } as never)
        .pipe(take(1)),
    );
    jest.advanceTimersByTime(30_000);
    const message = await first;
    jest.useRealTimers();
    expect(Object.keys(message).sort()).toEqual(['data', 'type']);
    expect(scope.scopeStream).not.toHaveBeenCalled();
  });

  it("streams the real changes through the caller's scope", () => {
    const { controller, scope } = make();
    controller.stream({ user } as never);
    expect(scope.scopeStream).toHaveBeenCalledWith(
      user,
      NEVER,
      expect.any(Function),
      false,
    );
    controller.stream({ user } as never, 'true');
    expect(scope.scopeStream).toHaveBeenLastCalledWith(
      user,
      NEVER,
      expect.any(Function),
      true,
    );
  });
});
