import { MacroRegion } from '@flui-cloud/infra';

export interface ProviderRegion {
  id: string;
  name: string;
  displayName: string;
  location: string;
  available: boolean;
  flagEmoji?: string;
  /**
   * What a provider calls the country. Hetzner answers with an ISO code and OVH
   * with a name, so this is display text and nothing may be decided from it.
   */
  country?: string;
  /** ISO 3166-1 alpha-2. The one field the macro-region is derived from. */
  countryCode?: string;
  /** Derived from `countryCode`; absent when the country is not recognised. */
  macroRegion?: MacroRegion;
  latitude?: number;
  longitude?: number;
}
