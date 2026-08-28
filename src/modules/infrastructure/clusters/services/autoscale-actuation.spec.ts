import {
  AutoscaleActuation,
  AutoscaleActuationFacts,
  describeAutoscaleActuation,
  describeCapacityOutcome,
  isAlertOnly,
  resolveAutoscaleActuation,
} from './autoscale-actuation';
import { AutoscaleActuationService } from './autoscale-actuation.service';
import { AutoscaleReconcilerRegistry } from './autoscale-reconciler.registry';
import { CloudProvider } from '../../../providers/enums/cloud-provider.enum';
import { ByosCapabilitiesService } from '../../../providers/implementations/byos/byos-capabilities.service';
import { ContaboCapabilitiesService } from '../../../providers/implementations/contabo/contabo-capabilities.service';
import { CapabilitiesProviderFactory } from '../../../providers/core/factories/capabilities-provider.factory';
import { IProviderCapabilitiesService } from '../../../providers/interfaces/provider-capabilities.interface';

const facts = (
  overrides: Partial<AutoscaleActuationFacts> = {},
): AutoscaleActuationFacts => ({
  provider: 'hetzner',
  nodeProvisioning: true,
  hasSizeCatalog: true,
  driven: false,
  ...overrides,
});

describe('resolveAutoscaleActuation', () => {
  it('is NOT_DRIVEN where Flui can provision but nothing is registered to act', () => {
    expect(resolveAutoscaleActuation(facts())).toBe(
      AutoscaleActuation.NOT_DRIVEN,
    );
  });

  it('becomes AUTOMATIC the moment something registers, with no other change', () => {
    expect(resolveAutoscaleActuation(facts({ driven: true }))).toBe(
      AutoscaleActuation.AUTOMATIC,
    );
  });

  it('is an alert with a shape where the provider has a catalogue', () => {
    expect(
      resolveAutoscaleActuation(
        facts({ provider: 'contabo', nodeProvisioning: false }),
      ),
    ).toBe(AutoscaleActuation.ALERT_ONLY_SIZED);
  });

  it('is an alert without a shape where the provider has no catalogue', () => {
    expect(
      resolveAutoscaleActuation(
        facts({
          provider: 'byos',
          nodeProvisioning: false,
          hasSizeCatalog: false,
        }),
      ),
    ).toBe(AutoscaleActuation.ALERT_ONLY_UNSIZED);
  });

  it('stays an alert even if a reconciler is registered — it cannot buy here', () => {
    expect(
      resolveAutoscaleActuation(
        facts({ nodeProvisioning: false, driven: true }),
      ),
    ).toBe(AutoscaleActuation.ALERT_ONLY_SIZED);
  });

  it('treats both alert cases as alert-only', () => {
    expect(isAlertOnly(AutoscaleActuation.ALERT_ONLY_SIZED)).toBe(true);
    expect(isAlertOnly(AutoscaleActuation.ALERT_ONLY_UNSIZED)).toBe(true);
    expect(isAlertOnly(AutoscaleActuation.NOT_DRIVEN)).toBe(false);
    expect(isAlertOnly(AutoscaleActuation.AUTOMATIC)).toBe(false);
  });
});

describe('describeAutoscaleActuation', () => {
  it('says nothing acts on its own where nothing does', () => {
    const text = describeAutoscaleActuation(
      AutoscaleActuation.NOT_DRIVEN,
      'hetzner',
    );
    expect(text).toContain('nothing adds one on its own');
    expect(text).toContain('hetzner');
  });

  it('offers a size and a price only where a catalogue exists', () => {
    const sized = describeAutoscaleActuation(
      AutoscaleActuation.ALERT_ONLY_SIZED,
      'contabo',
    );
    const unsized = describeAutoscaleActuation(
      AutoscaleActuation.ALERT_ONLY_UNSIZED,
      'byos',
    );
    expect(sized).toContain('name the size to buy and what it costs');
    expect(unsized).not.toContain('what it costs');
    expect(unsized).toContain('how much CPU and memory');
  });

  it('gives each case its own sentence', () => {
    const all = [
      AutoscaleActuation.AUTOMATIC,
      AutoscaleActuation.NOT_DRIVEN,
      AutoscaleActuation.ALERT_ONLY_SIZED,
      AutoscaleActuation.ALERT_ONLY_UNSIZED,
    ].map((a) => describeAutoscaleActuation(a, 'x'));
    expect(new Set(all).size).toBe(4);
  });
});

describe('describeCapacityOutcome', () => {
  it('warns that the workload stays pending where nothing drives scaling', () => {
    const text = describeCapacityOutcome(
      AutoscaleActuation.NOT_DRIVEN,
      'autoscaling_pending',
    );
    expect(text).toContain('nothing adds a node on its own');
    expect(text).toContain('pending');
  });

  it('says no node will appear where Flui cannot provision', () => {
    const text = describeCapacityOutcome(
      AutoscaleActuation.ALERT_ONLY_SIZED,
      'autoscaling_pending',
    );
    expect(text).toContain('no node will appear');
  });

  it('promises a node only where something actually adds one', () => {
    const text = describeCapacityOutcome(
      AutoscaleActuation.AUTOMATIC,
      'autoscaling_pending',
    );
    expect(text).toContain('a node will be added');
  });

  it('does not mention autoscaling when it is off', () => {
    const text = describeCapacityOutcome(
      AutoscaleActuation.NOT_DRIVEN,
      'insufficient_resources',
    );
    expect(text).not.toContain('Autoscaling');
  });
});

describe('AutoscaleActuationService', () => {
  const buildFactory = (
    provider: CloudProvider,
    service: IProviderCapabilitiesService,
  ): CapabilitiesProviderFactory =>
    new CapabilitiesProviderFactory([{ provider, service }]);

  it('reads the real BYOS capability: alert, and no catalogue to size it with', async () => {
    const service = new AutoscaleActuationService(
      buildFactory(CloudProvider.BYOS, new ByosCapabilitiesService()),
      new AutoscaleReconcilerRegistry(),
    );
    const described = await service.describe(CloudProvider.BYOS);
    expect(described.actuation).toBe(AutoscaleActuation.ALERT_ONLY_UNSIZED);
    expect(described.facts.nodeProvisioning).toBe(false);
    expect(described.facts.hasSizeCatalog).toBe(false);
  });

  it('reads the real Contabo capability: alert, but a catalogue to size it with', async () => {
    const service = new AutoscaleActuationService(
      buildFactory(
        CloudProvider.CONTABO,
        new ContaboCapabilitiesService({ get: () => undefined } as never),
      ),
      new AutoscaleReconcilerRegistry(),
    );
    const described = await service.describe(CloudProvider.CONTABO);
    expect(described.actuation).toBe(AutoscaleActuation.ALERT_ONLY_SIZED);
    expect(described.facts.hasSizeCatalog).toBe(true);
  });

  it('treats an unregistered provider as unable to provision', async () => {
    const service = new AutoscaleActuationService(
      new CapabilitiesProviderFactory([]),
      new AutoscaleReconcilerRegistry(),
    );
    const described = await service.describe('nowhere');
    expect(described.actuation).toBe(AutoscaleActuation.ALERT_ONLY_UNSIZED);
  });

  it('follows the registry rather than a constant', async () => {
    const registry = new AutoscaleReconcilerRegistry();
    const capabilities = {
      getStaticCapabilities: () => ({
        features: { nodeProvisioning: true },
      }),
      getSupportedInstanceTypes: async () => [],
    } as unknown as IProviderCapabilitiesService;
    const service = new AutoscaleActuationService(
      buildFactory(CloudProvider.HETZNER, capabilities),
      registry,
    );

    expect((await service.describe(CloudProvider.HETZNER)).actuation).toBe(
      AutoscaleActuation.NOT_DRIVEN,
    );

    registry.register('cluster-autoscale-reconciler');

    expect((await service.describe(CloudProvider.HETZNER)).actuation).toBe(
      AutoscaleActuation.AUTOMATIC,
    );
  });

  it('does not ask a provisioning provider for its catalogue', async () => {
    const getSupportedInstanceTypes = jest.fn();
    const capabilities = {
      getStaticCapabilities: () => ({
        features: { nodeProvisioning: true },
      }),
      getSupportedInstanceTypes,
    } as unknown as IProviderCapabilitiesService;
    const service = new AutoscaleActuationService(
      buildFactory(CloudProvider.HETZNER, capabilities),
      new AutoscaleReconcilerRegistry(),
    );

    await service.describe(CloudProvider.HETZNER);
    expect(getSupportedInstanceTypes).not.toHaveBeenCalled();
  });

  it('falls back to no catalogue when the provider lookup throws', async () => {
    const capabilities = {
      getStaticCapabilities: () => ({
        features: { nodeProvisioning: false },
      }),
      getSupportedInstanceTypes: async () => {
        throw new Error('provider unreachable');
      },
    } as unknown as IProviderCapabilitiesService;
    const service = new AutoscaleActuationService(
      buildFactory(CloudProvider.CONTABO, capabilities),
      new AutoscaleReconcilerRegistry(),
    );

    const described = await service.describe(CloudProvider.CONTABO);
    expect(described.actuation).toBe(AutoscaleActuation.ALERT_ONLY_UNSIZED);
  });
});
