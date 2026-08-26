import type { ProviderFactory } from 'src/modules/providers/core/factories/provider.factory';
import type { FirewallProviderFactory } from 'src/modules/providers/core/factories/firewall-provider.factory';
import type { CloudProvider } from 'src/modules/providers/enums/cloud-provider.enum';
import type { DiscoveredResource } from './plan';

/**
 * What actually exists on the customer's account right now.
 *
 * Deliberately *unfiltered* where the provider lets it be. It would be simpler
 * to ask only for Flui-marked resources, and it would also be worse: a
 * customer's own server that happens to share a name with one from the run
 * would then be invisible, the entry would read "already gone", and nobody
 * would ever learn that the list and the account disagree. Listing everything
 * lets `plan.ts` say the true thing — *found it, it is not ours, refusing*.
 *
 * Two listings cannot be unfiltered, and it is worth knowing which: Hetzner's
 * `listSSHKeys` drops anything without a Flui label before we see it, and
 * `listFluiManagedVolumes` is a label query by construction. For those two, an
 * unmarked namesake reads as absent rather than as refused. Safe either way —
 * nothing unmarked can be deleted — but less informative.
 */
export interface Discovery {
  readonly resources: readonly DiscoveredResource[];
  /** Listings that failed. A non-empty list means the view is partial. */
  readonly failures: readonly string[];
}

export async function discoverResources(
  provider: CloudProvider,
  providerFactory: ProviderFactory,
  firewallFactory: FirewallProviderFactory,
): Promise<Discovery> {
  const resources: DiscoveredResource[] = [];
  const failures: string[] = [];

  const collect = async (
    what: string,
    load: () => Promise<DiscoveredResource[]>,
  ): Promise<void> => {
    try {
      resources.push(...(await load()));
    } catch (error) {
      failures.push(
        `Could not list ${what} on ${provider}: ${(error as Error).message}`,
      );
    }
  };

  let svc: ReturnType<ProviderFactory['getProvider']>;
  try {
    svc = providerFactory.getProvider(provider);
  } catch (error) {
    return {
      resources,
      failures: [`${provider} is unavailable: ${(error as Error).message}`],
    };
  }

  await collect('servers', async () =>
    (await svc.listServersAsDto()).map((server) => ({
      provider,
      kind: 'server' as const,
      providerId: server.provider_resource_id || server.id,
      name: server.name,
      region: server.location,
      labels: fromPairs(server.labels),
      createdAt: iso(server.created_at),
    })),
  );

  await collect('SSH keys', async () =>
    ((await svc.listSSHKeys?.()) ?? []).map((key) => ({
      provider,
      kind: 'ssh-key' as const,
      providerId: key.providerKeyId || key.id,
      name: key.name,
      labels: flatten(key.tags),
      createdAt: iso(key.createdAt),
    })),
  );

  await collect('volumes', async () =>
    ((await svc.listFluiManagedVolumes?.()) ?? []).map((volume) => ({
      provider,
      kind: 'volume' as const,
      providerId: volume.volumeId,
      name: volume.name,
      region: volume.region,
      labels: volume.labels ?? {},
      createdAt: volume.createdAt ?? null,
      attachedTo: volume.attachedServerId ?? null,
    })),
  );

  await collect('networks', async () =>
    ((await svc.listVNets?.()) ?? []).map((vnet) => ({
      provider,
      kind: 'network' as const,
      providerId: vnet.id,
      name: vnet.name,
      labels: vnet.labels ?? {},
      createdAt: vnet.created ?? null,
    })),
  );

  const firewalls = firewallFactory.getFirewallProvider(provider);
  if (firewalls) {
    await collect('firewalls', async () =>
      (await firewalls.listFirewalls()).map((firewall) => ({
        provider,
        kind: 'firewall' as const,
        providerId: firewall.id,
        name: firewall.name,
        labels: firewall.labels ?? {},
        // No provider reports a creation time for a firewall, so the
        // "older than the run" check cannot fire on one. The ownership label
        // and the name in the list are all it has.
        createdAt: null,
      })),
    );
  }

  return { resources, failures };
}

function fromPairs(
  labels: readonly { key: string; value: string }[] | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const label of labels ?? []) out[label.key] = label.value;
  return out;
}

/** Hetzner maps its labels onto `tags`, where a value may arrive as a list. */
function flatten(
  tags: Record<string, string | string[]> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags ?? {})) {
    out[key] = Array.isArray(value) ? (value[0] ?? '') : value;
  }
  return out;
}

function iso(value: Date | string | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}
