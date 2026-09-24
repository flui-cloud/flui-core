import { ConfigService } from '@nestjs/config';
import { buyableRegionsOf, scalingCapabilityOf } from './scaling-capability';
import { ByosCapabilitiesService } from '../../providers/implementations/byos/byos-capabilities.service';
import { ContaboCapabilitiesService } from '../../providers/implementations/contabo/contabo-capabilities.service';
import { HetznerCapabilitiesService } from '../../providers/implementations/hetzner/hetzner-capabilities.service';
import { OvhCapabilitiesService } from '../../providers/implementations/ovh/ovh-capabilities.service';
import { ScalewayCapabilitiesService } from '../../providers/implementations/scaleway/scaleway-capabilities.service';
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

/**
 * Read off the same declarations, for the same reason: the claim is that where
 * a group may buy follows from the network each provider describes, and a
 * fixture would let the function and the product drift apart while both stay
 * green.
 */
describe('where a scaling group may buy', () => {
  const hetzner = () =>
    new HetznerCapabilitiesService(config, credentials).getStaticCapabilities();
  const scaleway = () =>
    new ScalewayCapabilitiesService(credentials).getStaticCapabilities();
  const ovh = () =>
    new OvhCapabilitiesService(config, credentials).getStaticCapabilities();
  const byos = () => new ByosCapabilitiesService().getStaticCapabilities();
  const contabo = () =>
    new ContaboCapabilitiesService(config).getStaticCapabilities();

  it('opens a Hetzner group to the whole zone its cluster sits in', () => {
    expect(
      buyableRegionsOf({ region: 'fsn1' }, hetzner(), 'eu-central'),
    ).toEqual(['fsn1', 'nbg1', 'hel1']);
  });

  it('does not let a Hetzner group reach across zones', () => {
    const allowed = buyableRegionsOf(
      { region: 'fsn1' },
      hetzner(),
      'eu-central',
    );
    expect(allowed).not.toContain('ash');
  });

  it('finds the zone from the region when the cluster never recorded one', () => {
    expect(buyableRegionsOf({ region: 'nbg1' }, hetzner(), null)).toEqual([
      'fsn1',
      'nbg1',
      'hel1',
    ]);
  });

  /** One zone per region there, so the zone is the region. */
  it('holds a Scaleway group to its own region', () => {
    expect(
      buyableRegionsOf({ region: 'nl-ams' }, scaleway(), 'nl-ams'),
    ).toEqual(['nl-ams']);
  });

  /**
   * OVH declares no zones on purpose — the regions a credential reaches come
   * from Keystone — so nothing here can group two. Its own region is the only
   * one the declarations say can join its network.
   */
  it('holds an OVH group to its own region, having no zones to group by', () => {
    expect(buyableRegionsOf({ region: 'GRA11' }, ovh(), null)).toEqual([
      'GRA11',
    ]);
  });

  it('fences nothing where Flui builds the network itself', () => {
    expect(buyableRegionsOf({ region: 'anywhere' }, byos(), null)).toBeNull();
    expect(buyableRegionsOf({ region: 'EU' }, contabo(), null)).toBeNull();
  });

  it('fences nothing for a provider it knows nothing about', () => {
    expect(buyableRegionsOf({ region: 'x' }, null, null)).toBeNull();
  });
});
