import { NodeSizeDto } from '../../dto/node-size.dto';
import { ovhRegionCode } from './ovh-region-metadata';

/** Only base Linux shapes: `win-*` carry a Windows licence and `-flex` change the disk contract. */
const BASE_FLAVOR = /^[a-z0-9]+-\d+$/;

interface NovaFlavor {
  name: string;
  vcpus: number;
  /** MiB. */
  ram: number;
  /** GB. */
  disk: number;
}

export interface NovaFlavorSource {
  /** Keystone region ids, e.g. `GRA11`, `EU-SOUTH-MIL`. */
  regions(serviceType?: string): Promise<string[]>;
  listFlavorsDetail(region: string): Promise<NovaFlavor[]>;
}

/** Price lookup by flavor name, taken from the public ordering catalog. */
export interface FlavorPricing {
  hourly?: number;
  monthly?: number;
  storageType?: 'local' | 'network';
  cpuType?: 'shared' | 'dedicated';
  deprecated?: boolean;
}

/**
 * Node sizes as Nova reports them, region by region.
 *
 * The public ordering catalog is a better price source than Nova — Nova has no
 * prices at all — but a worse availability source: it only covers OVH's classic
 * regions, so a flavor that exists in Milan appears nowhere in it. Asking Nova
 * which shapes a region really has, and the catalog only what they cost, is the
 * combination that makes the newer regions usable.
 *
 * A flavor Nova offers in a region the catalog has never heard of still comes
 * back, priced as unknown rather than as zero — the same convention the rest of
 * Flui uses, because zero reads as free.
 */
export async function getOvhNodeSizesFromNova(
  client: NovaFlavorSource,
  pricing: Map<string, FlavorPricing>,
): Promise<NodeSizeDto[]> {
  const regions = await client.regions('compute');
  const byName = new Map<string, NodeSizeDto>();

  const perRegion = await Promise.all(
    regions.map(async (region) => ({
      region,
      flavors: await client.listFlavorsDetail(region),
    })),
  );

  for (const { region, flavors } of perRegion) {
    const code = ovhRegionCode(region);
    for (const flavor of flavors) {
      if (!BASE_FLAVOR.test(flavor.name)) continue;
      const price = pricing.get(flavor.name);
      let size = byName.get(flavor.name);
      if (!size) {
        size = {
          id: flavor.name,
          name: flavor.name,
          description: `${flavor.vcpus} vCPU, ${Math.round(flavor.ram / 1000)} GB RAM, ${flavor.disk} GB ${price?.storageType ?? 'local'}`,
          cores: flavor.vcpus,
          // Nova reports MiB, the ordering catalog whole GB, and the two must
          // agree or the same flavor changes size depending on which region it
          // was discovered in. OVH populates Nova with 1000 MiB per GB of the
          // flavor's own name — c3-4 is 4000 MiB, r3-1024 is 1024000 — so
          // dividing by 1000 reproduces the catalog for all 65 shapes, while
          // the intuitive /1024 disagrees on 51 of them.
          memory: Math.round(flavor.ram / 1000),
          disk: flavor.disk,
          storageType: price?.storageType ?? 'local',
          cpuType: price?.cpuType ?? 'shared',
          architecture: 'x86',
          deprecated: price?.deprecated ?? false,
          bareMetal: false,
          managedFirewall: false,
          supportsHourlyBilling: true,
          prices: [],
          locations: [],
          availability: [],
        };
        byName.set(flavor.name, size);
      }
      if (size.prices.some((p) => p.location === code)) continue;
      if (price?.hourly != null) {
        size.prices.push({
          location: code,
          priceHourly: {
            net: String(price.hourly),
            gross: String(price.hourly),
          },
          priceMonthly: {
            net: String(
              price.monthly ?? Math.round(price.hourly * 730 * 100) / 100,
            ),
            gross: String(
              price.monthly ?? Math.round(price.hourly * 730 * 100) / 100,
            ),
          },
        });
      }
      size.locations.push({
        id: size.locations.length,
        name: code,
        deprecation: null,
      });
      size.availability!.push({
        location: code,
        // Not a claim, a default. Nova lists the flavors a region offers, never
        // whether one can be built there right now — that is decided by the
        // scheduler at the moment of the request, and OVH exposes no way to ask
        // it in advance with the credentials Flui holds. Saying `true` here
        // used to read as a promise; `availabilityKnown: false` is what makes
        // it an admission.
        available: true,
        availabilityKnown: false,
        deprecated: false,
      });
    }
  }

  return [...byName.values()].sort((a, b) => {
    const pa = Number(a.prices[0]?.priceHourly.net ?? Infinity);
    const pb = Number(b.prices[0]?.priceHourly.net ?? Infinity);
    return pa - pb;
  });
}
