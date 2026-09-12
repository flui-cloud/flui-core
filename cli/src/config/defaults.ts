export const CLI_DEFAULTS = {
  SERVER_TYPE_CACHE_TTL_HOURS: 12,

  HETZNER_EU_REGIONS: ['nbg1', 'fsn1', 'hel1'] as const,
  DEFAULT_HETZNER_REGION: 'nbg1' as const,

  SCALEWAY_EU_REGIONS: ['fr-par', 'nl-ams', 'pl-waw'] as const,
  DEFAULT_SCALEWAY_REGION: 'fr-par' as const,

  // OVH macro-region codes (city-level, see OVH_REGIONS in @flui-cloud/infra).
  // GRA/SBG/DE/UK/WAW are EU; BHS/SGP/SYD are excluded here as non-EU.
  OVH_EU_REGIONS: ['GRA', 'SBG', 'DE', 'UK', 'WAW'] as const,
  DEFAULT_OVH_REGION: 'GRA' as const,

  FALLBACK_SERVER_TYPES: {
    hetzner: ['cx23', 'cx33', 'cx32', 'cpx21', 'cx42', 'cpx31'],
    scaleway: ['DEV1-M', 'DEV1-L', 'GP1-XS', 'GP1-S'],
    // d2-2 (2GB) is listed last: it undersizes a control cluster's stack
    // (Postgres+Redis+Zitadel+observability) below MIN_SPECS.observability
    // below, live-confirmed by Redis never becoming ready on one — fine for
    // a workload cluster, not offered first here.
    ovh: ['d2-4', 'd2-8', 'c3-4', 'd2-2'],
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

export function getHetznerEuRegions(): string[] {
  return [...CLI_DEFAULTS.HETZNER_EU_REGIONS];
}

export function getDefaultHetznerRegion(): string {
  return CLI_DEFAULTS.DEFAULT_HETZNER_REGION;
}

export function getScalewayEuRegions(): string[] {
  return [...CLI_DEFAULTS.SCALEWAY_EU_REGIONS];
}

export function getDefaultScalewayRegion(): string {
  return CLI_DEFAULTS.DEFAULT_SCALEWAY_REGION;
}

export function getOvhEuRegions(): string[] {
  return [...CLI_DEFAULTS.OVH_EU_REGIONS];
}

export function getDefaultOvhRegion(): string {
  return CLI_DEFAULTS.DEFAULT_OVH_REGION;
}

export function getEuRegions(provider: string): string[] {
  if (provider === 'scaleway') return getScalewayEuRegions();
  if (provider === 'ovh') return getOvhEuRegions();
  return getHetznerEuRegions();
}

export function getDefaultRegion(provider: string): string {
  if (provider === 'scaleway') return getDefaultScalewayRegion();
  if (provider === 'ovh') return getDefaultOvhRegion();
  return getDefaultHetznerRegion();
}
