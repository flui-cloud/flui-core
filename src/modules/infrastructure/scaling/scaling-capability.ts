import { ProviderCapabilities } from '../../management/entities/provider-capabilities.entity';

/**
 * What the provider lets a cluster do about its own size.
 *
 * Three flags rather than one ladder: a provider with a catalogue and no create
 * API is not a lesser version of one that can buy, it is a different sentence
 * addressed to a person.
 */
export interface ProviderScalingCapability {
  provider: string;
  /** Flui can create a server through the provider's own API. */
  canProvision: boolean;
  /** There is a list of shapes to read, and a price attached to each. */
  hasCatalogue: boolean;
  /** `none` means Flui never sees a bill for these machines. */
  billing: 'hourly' | 'monthly' | 'none';
}

/**
 * Derived from the declarations, never from the provider's name.
 *
 * `nodeProvisioning` is false on two providers that behave nothing alike, and
 * what separates them is the catalogue. `supportedInstanceTypes` alone cannot
 * say so: it is empty on a provider whose live catalogue has merely not been
 * read yet, and empty for good only where the machines arrive from the operator
 * over SSH instead of from a server API — which is what `credentialType` says.
 *
 * An unregistered provider gets the closed answer: it buys nothing, publishes
 * nothing, and is billed for nothing anyone can see.
 */
export function scalingCapabilityOf(
  provider: string,
  capabilities: ProviderCapabilities | null,
): ProviderScalingCapability {
  if (!capabilities) {
    return {
      provider,
      canProvision: false,
      hasCatalogue: false,
      billing: 'none',
    };
  }

  const hasCatalogue =
    capabilities.supportedInstanceTypes.length > 0 ||
    capabilities.credentialType !== 'ssh';

  return {
    provider,
    canProvision: capabilities.features.nodeProvisioning,
    hasCatalogue,
    billing: hasCatalogue ? capabilities.pricing.billingCycle : 'none',
  };
}
