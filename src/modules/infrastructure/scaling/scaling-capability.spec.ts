import { ConfigService } from '@nestjs/config';
import { scalingCapabilityOf } from './scaling-capability';
import { ByosCapabilitiesService } from '../../providers/implementations/byos/byos-capabilities.service';
import { ContaboCapabilitiesService } from '../../providers/implementations/contabo/contabo-capabilities.service';
import { HetznerCapabilitiesService } from '../../providers/implementations/hetzner/hetzner-capabilities.service';
import { ICredentialProvider } from '../../providers/interfaces/credential-provider.interface';

const config = {
  get: (_key: string, fallback?: unknown) => fallback,
} as unknown as ConfigService;

const credentials = {} as unknown as ICredentialProvider;

/**
 * Read off the declarations the providers publish, not off fixtures: the whole
 * claim being tested is that the answer follows from what a provider says about
 * itself, and a hand-written copy of those flags could agree with the function
 * while both disagree with the product.
 */
describe('what a provider lets a cluster do about its own size', () => {
  it('lets Hetzner buy, from a catalogue billed by the hour', () => {
    const hetzner = new HetznerCapabilitiesService(config, credentials);
    expect(
      scalingCapabilityOf('hetzner', hetzner.getStaticCapabilities()),
    ).toEqual({
      provider: 'hetzner',
      canProvision: true,
      hasCatalogue: true,
      billing: 'hourly',
    });
  });

  /**
   * The case that makes the two flags necessary. Contabo cannot buy either, and
   * is nothing like BYOS: it publishes shapes and prices, so an alarm here can
   * name what to order and what it costs.
   */
  it('gives Contabo a catalogue it cannot buy from', () => {
    const contabo = new ContaboCapabilitiesService(config);
    expect(
      scalingCapabilityOf('contabo', contabo.getStaticCapabilities()),
    ).toEqual({
      provider: 'contabo',
      canProvision: false,
      hasCatalogue: true,
      billing: 'monthly',
    });
  });

  it('leaves BYOS with no shapes, no regions and no bill', () => {
    const byos = new ByosCapabilitiesService();
    expect(scalingCapabilityOf('byos', byos.getStaticCapabilities())).toEqual({
      provider: 'byos',
      canProvision: false,
      hasCatalogue: false,
      billing: 'none',
    });
  });

  /**
   * A provider with a catalogue that has simply not been read yet must not be
   * mistaken for one that will never have any.
   */
  it('reads a catalogue from a live list too, not only from the credential', () => {
    const contabo = new ContaboCapabilitiesService(config);
    const live = {
      ...contabo.getStaticCapabilities(),
      supportedInstanceTypes: ['vps-10', 'vps-20'],
    };
    expect(scalingCapabilityOf('contabo', live).hasCatalogue).toBe(true);
  });

  it('closes every door on a provider it does not know', () => {
    expect(scalingCapabilityOf('someone-else', null)).toEqual({
      provider: 'someone-else',
      canProvision: false,
      hasCatalogue: false,
      billing: 'none',
    });
  });
});
