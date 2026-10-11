import { fitToArea, guestAreaRefusal } from './guest-area';
import { SandboxTenantState } from '../../sandbox/entities/sandbox-tenant.entity';

describe('where a guest application may be deployed', () => {
  const rows = [
    {
      userId: 'g1',
      state: SandboxTenantState.EXPIRED,
      namespace: 'p-area-old',
    },
    {
      userId: 'g1',
      state: SandboxTenantState.CLAIMED,
      namespace: 'p-area-now',
    },
  ];
  const tenants = {
    findOne: jest.fn(
      async ({ where }: { where: Record<string, unknown> }) =>
        rows.find((r) =>
          Object.entries(where).every(
            ([k, v]) => (r as Record<string, unknown>)[k] === v,
          ),
        ) ?? null,
    ),
  };

  it('deploys into the area the guest holds now, whatever expired before it', async () => {
    await expect(
      guestAreaRefusal(
        { userId: 'g1', k8sNamespace: 'p-area-now' },
        tenants as never,
      ),
    ).resolves.toBeNull();
  });

  it('refuses any other space, the guest’s expired area included', async () => {
    await expect(
      guestAreaRefusal(
        { userId: 'g1', k8sNamespace: 'p-area-old' },
        tenants as never,
      ),
    ).resolves.toMatch(/only in its own area/);
    await expect(
      guestAreaRefusal(
        { userId: 'g1', k8sNamespace: 'kube-system' },
        tenants as never,
      ),
    ).resolves.toMatch(/only in its own area/);
  });

  it('leaves alone an application of someone who holds no area', async () => {
    await expect(
      guestAreaRefusal(
        { userId: 'admin', k8sNamespace: 'anything' },
        tenants as never,
      ),
    ).resolves.toBeNull();
    await expect(
      guestAreaRefusal(
        { userId: null, k8sNamespace: 'flui-system' },
        tenants as never,
      ),
    ).resolves.toBeNull();
  });
});

describe('an application fitted to a guest area', () => {
  const quota = { maxContainerCpu: '1', maxContainerMemory: '1Gi' };
  const app = (
    cpu: { request?: string; limit?: string },
    memory: { request?: string; limit?: string },
  ) => ({ resources: { cpu, memory } }) as never;

  it('brings a catalogue entry written for a whole machine down to the area ceiling', () => {
    const fitted = fitToArea(
      app({ request: '250m', limit: '2' }, { request: '256Mi', limit: '2Gi' }),
      quota,
    ) as {
      resources: {
        cpu: { request: string; limit: string };
        memory: { request: string; limit: string };
      };
    };
    expect(fitted.resources.cpu).toEqual({ request: '250m', limit: '1' });
    expect(fitted.resources.memory).toEqual({ request: '256Mi', limit: '1Gi' });
  });

  it('never leaves a request above the limit it was brought to', () => {
    const fitted = fitToArea(
      app({ request: '2', limit: '4' }, { request: '3Gi', limit: '4Gi' }),
      quota,
    ) as {
      resources: { cpu: { request: string }; memory: { request: string } };
    };
    expect(fitted.resources.cpu.request).toBe('1');
    expect(fitted.resources.memory.request).toBe('1Gi');
  });

  it('leaves an application that already fits untouched', () => {
    const fits = app(
      { request: '100m', limit: '500m' },
      { request: '128Mi', limit: '512Mi' },
    );
    expect(fitToArea(fits, quota)).toBe(fits);
  });
});
