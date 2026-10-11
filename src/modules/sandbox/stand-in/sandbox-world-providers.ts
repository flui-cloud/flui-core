/**
 * The providers of the example world: every provider Flui offers, described as
 * the real catalogue describes it, with Hetzner the one Northwind Labs has
 * connected.
 *
 * Nothing here is retyped. The definitions come from the very capability
 * services `GET /management/providers` reads, asked only what needs no account:
 * what the provider is, what it can do, which credential it asks for and where
 * it can place machines. They are handed no credentials at all, so a question
 * that would need one has nothing to be answered with.
 *
 * The rules at the head of `sandbox-world.ts` hold here too. Rule 5 in
 * particular: a provider's credential fields say what the form asks for and
 * where to find it in the provider's console. They are field names, never a
 * value, and none is ever filled in.
 */

import { ConfigService } from '@nestjs/config';
import { CapabilitiesProviderFactory } from '../../providers/core/factories/capabilities-provider.factory';
import { CloudProvider } from '../../providers/enums/cloud-provider.enum';
import { ICredentialProvider } from '../../providers/interfaces/credential-provider.interface';
import { ByosCapabilitiesService } from '../../providers/implementations/byos/byos-capabilities.service';
import { ContaboCapabilitiesService } from '../../providers/implementations/contabo/contabo-capabilities.service';
import { HetznerCapabilitiesService } from '../../providers/implementations/hetzner/hetzner-capabilities.service';
import { OvhCapabilitiesService } from '../../providers/implementations/ovh/ovh-capabilities.service';
import { ScalewayCapabilitiesService } from '../../providers/implementations/scaleway/scaleway-capabilities.service';
import { ProviderDefinitionsService } from '../../management/services/provider-definitions.service';
import {
  EXAMPLE_REGION,
  PROVIDER,
  SandboxStandInQuery,
  mark,
  minutesAgo,
} from './sandbox-world-core';

const noCredentials = (): Promise<never> =>
  Promise.reject(new Error('The example world holds no credentials.'));

const NO_CREDENTIALS: ICredentialProvider = {
  getActiveApiToken: noCredentials,
  getActiveAccessKeyPair: noCredentials,
  getActiveBearerToken: noCredentials,
};

let catalogue: ProviderDefinitionsService | undefined;

/** The same registry the providers module builds, minus every credential. */
function realCatalogue(): ProviderDefinitionsService {
  if (catalogue) return catalogue;
  const config = new ConfigService();
  catalogue = new ProviderDefinitionsService(
    new CapabilitiesProviderFactory([
      {
        provider: CloudProvider.HETZNER,
        service: new HetznerCapabilitiesService(config, NO_CREDENTIALS),
      },
      {
        provider: CloudProvider.CONTABO,
        service: new ContaboCapabilitiesService(config),
      },
      {
        provider: CloudProvider.SCALEWAY,
        service: new ScalewayCapabilitiesService(NO_CREDENTIALS),
      },
      { provider: CloudProvider.BYOS, service: new ByosCapabilitiesService() },
      {
        provider: CloudProvider.OVH,
        service: new OvhCapabilitiesService(config, NO_CREDENTIALS),
      },
    ]),
  );
  return catalogue;
}

/** Every object, however deep, says it is an example. */
function markAll<T>(value: T): T {
  if (Array.isArray(value)) return value.map(markAll) as T;
  if (
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return mark(
      Object.fromEntries(
        Object.entries(value).map(([key, inner]) => [key, markAll(inner)]),
      ),
    ) as T;
  }
  return value;
}

/**
 * Where a provider can place machines, as its catalogue says without an
 * account. The connected one answers with the region the rest of the world
 * lives in: a detail screen listing regions no machine, network or
 * configuration ever mentions is a section arguing with itself.
 */
async function regionsOf(provider: string) {
  if (provider === PROVIDER) return [EXAMPLE_REGION];
  return markAll(
    await realCatalogue().getProviderRegions(provider as CloudProvider),
  );
}

export async function exampleProviders(_now?: number) {
  const definitions = await realCatalogue().getAllProviders();
  return Promise.all(
    definitions.map(async (definition) =>
      markAll({
        ...definition,
        configured: definition.id === PROVIDER,
        capabilities: {
          ...definition.capabilities,
          supportedRegions: await regionsOf(definition.id),
        },
      }),
    ),
  );
}

export async function exampleProvider(
  now: number,
  _query?: SandboxStandInQuery,
  params?: Record<string, string | undefined>,
) {
  const wanted = params?.provider ?? PROVIDER;
  return (await exampleProviders(now)).find((p) => p.id === wanted) ?? null;
}

export async function exampleProviderRegions(
  _now?: number,
  _query?: SandboxStandInQuery,
  params?: Record<string, string | undefined>,
) {
  const wanted = params?.provider ?? PROVIDER;
  const offered = await realCatalogue().getAllProviders();
  return offered.some((p) => p.id === wanted) ? regionsOf(wanted) : [];
}

/**
 * The connected provider's last health check, the one its configuration
 * records. A provider nobody connected has no health to report.
 */
export function exampleProviderHealth(
  now: number,
  _query?: SandboxStandInQuery,
  params?: Record<string, string | undefined>,
) {
  if ((params?.provider ?? PROVIDER) !== PROVIDER) return null;
  return mark({
    providerId: PROVIDER,
    status: 'healthy',
    responseTime: 184,
    lastCheck: minutesAgo(now, 7),
    metrics: { apiCallsToday: 312, errorRate: 0 },
  });
}
