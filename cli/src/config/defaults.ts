import { OVH_REGION_METADATA } from 'src/modules/providers/implementations/ovh/ovh-region-metadata';

/** Every OVH region, read off the provider module's own metadata table. */
const OVH_REGION_CODES = Object.keys(OVH_REGION_METADATA);

export const CLI_DEFAULTS = {
  SERVER_TYPE_CACHE_TTL_HOURS: 12,

  // Hetzner's six locations across its four network zones, as its own API
  // reference lists them.
  HETZNER_REGIONS: ['nbg1', 'fsn1', 'hel1', 'ash', 'hil', 'sin'] as const,
  DEFAULT_HETZNER_REGION: 'nbg1' as const,

  // Scaleway sells instances from these three and nowhere else.
  SCALEWAY_REGIONS: ['fr-par', 'nl-ams', 'pl-waw'] as const,
  DEFAULT_SCALEWAY_REGION: 'fr-par' as const,

  // OVH region codes. Not a catalogue: the real list comes from the Keystone
  // service catalog and is per-credential, but `env create` validates the flag
  // before it boots the Nest app that could ask. This is the floor of regions
  // Flui knows how to place a control cluster in — derived from the same
  // metadata table the provider module uses, so a region is added in one place.
  OVH_REGIONS: OVH_REGION_CODES,
  DEFAULT_OVH_REGION: 'GRA' as const,

  FALLBACK_SERVER_TYPES: {
    hetzner: ['cx23', 'cx33', 'cx32', 'cpx21', 'cx42', 'cpx31'],
    scaleway: ['DEV1-M', 'DEV1-L', 'GP1-XS', 'GP1-S'],
    // The d2 family does not exist in Milan or Paris — those regions carry
    // only the current-generation c3/b3/r3 shapes — so c3-4 and b3-8, the two
    // that are present in all nine regions, follow the d2 entries rather than
    // sitting at the end. The create flow walks this list against real
    // per-region availability, so a d2-only default still resolves there.
    // d2-2 (2GB) is listed last: it undersizes a control cluster's stack
    // (Postgres+Redis+Zitadel+observability) below MIN_SPECS.observability
    // below, live-confirmed by Redis never becoming ready on one — fine for
    // a workload cluster, not offered first here.
    ovh: ['d2-4', 'd2-8', 'c3-4', 'b3-8', 'd2-2'],
  },

  RECOMMENDED_SERVER_TYPES: {
    hetzner: 'cx23',
    scaleway: 'DEV1-M',
    // d2-4: 2 vCPU / 4GB / 50GB, cheapest OVH flavor meeting
    // MIN_SPECS.observability below (~€0.0206/h).
    ovh: 'd2-4',
  },

  MIN_SPECS: {
    observability: {
      cores: 2,
      memory: 4,
      disk: 40,
    },
    production: {
      cores: 4,
      memory: 8,
      disk: 80,
    },
    development: {
      cores: 2,
      memory: 4,
      disk: 20,
    },
  },
} as const;

export const DEPRECATION_STRATEGY = {
  SHOW_WARNING: true,
  AUTO_SELECT_ALTERNATIVE: false,
  ALLOW_MANUAL_SELECTION: true,
} as const;

export type SupportedProvider =
  keyof typeof CLI_DEFAULTS.RECOMMENDED_SERVER_TYPES;

export function getRecommendedServerType(provider: string): string {
  return (
    CLI_DEFAULTS.RECOMMENDED_SERVER_TYPES[provider as SupportedProvider] ||
    CLI_DEFAULTS.RECOMMENDED_SERVER_TYPES.hetzner
  );
}

export function getFallbackServerTypes(provider: string): string[] {
  const types =
    CLI_DEFAULTS.FALLBACK_SERVER_TYPES[provider as SupportedProvider] ||
    CLI_DEFAULTS.FALLBACK_SERVER_TYPES.hetzner;
  return [...types];
}

export function getHetznerRegions(): string[] {
  return [...CLI_DEFAULTS.HETZNER_REGIONS];
}

export function getDefaultHetznerRegion(): string {
  return CLI_DEFAULTS.DEFAULT_HETZNER_REGION;
}

export function getScalewayRegions(): string[] {
  return [...CLI_DEFAULTS.SCALEWAY_REGIONS];
}

export function getDefaultScalewayRegion(): string {
  return CLI_DEFAULTS.DEFAULT_SCALEWAY_REGION;
}

export function getOvhRegions(): string[] {
  return [...CLI_DEFAULTS.OVH_REGIONS];
}

export function getDefaultOvhRegion(): string {
  return CLI_DEFAULTS.DEFAULT_OVH_REGION;
}

/** Every region this CLI will place a control cluster in, for one provider. */
export function getSupportedRegions(provider: string): string[] {
  if (provider === 'scaleway') return getScalewayRegions();
  if (provider === 'ovh') return getOvhRegions();
  return getHetznerRegions();
}

export function getDefaultRegion(provider: string): string {
  if (provider === 'scaleway') return getDefaultScalewayRegion();
  if (provider === 'ovh') return getDefaultOvhRegion();
  return getDefaultHetznerRegion();
}
