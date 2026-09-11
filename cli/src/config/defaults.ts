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
    ovh: ['d2-2', 'd2-4', 'd2-8', 'c3-4'],
  },

  RECOMMENDED_SERVER_TYPES: {
    hetzner: 'cx23',
    scaleway: 'DEV1-M',
    // Cheapest hourly-billed flavor in OVH's public catalog (~€0.0104/h).
    ovh: 'd2-2',
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
