import { CloudProvider } from '../../../providers/enums/cloud-provider.enum';

/**
 * How VAT reaches the prices Flui reads for a provider.
 *
 * - `provider-account`: the provider's pricing API returns every price net and
 *   gross, gross computed with the VAT rate of the account (Hetzner's
 *   `GET /pricing` names it as `vat_rate`).
 * - `excluded`: the catalogue Flui reads publishes prices without VAT and no
 *   rate beside them (Scaleway's instance catalogue, OVH's ordering catalogue).
 *   Flui never guesses a rate, so these amounts are shown excluding VAT.
 */
export type VatSource = 'provider-account' | 'excluded';

export interface ProviderBilling {
  /** A node is billed by the hour but never more than its monthly price in one calendar month. */
  capsAtMonthlyPrice: boolean;
  vat: VatSource;
  /** One sentence for a person, about how this provider turns hours into a bill. */
  billedAs: string;
}

/**
 * Only providers whose node prices Flui can read. Contabo exposes no price
 * list to Flui and BYOS machines are paid to whoever hosts them, so neither is
 * here: their lifetimes are counted but never priced.
 *
 * OVH instances are hourly without a cap unless monthly billing is chosen on
 * the instance, which Flui never does.
 */
export const PROVIDER_BILLING: Partial<Record<string, ProviderBilling>> = {
  [CloudProvider.HETZNER]: {
    capsAtMonthlyPrice: true,
    vat: 'provider-account',
    billedAs:
      'Billed by the hour, never more than the monthly price in one month',
  },
  [CloudProvider.SCALEWAY]: {
    capsAtMonthlyPrice: true,
    vat: 'excluded',
    billedAs:
      'Billed by the hour, never more than the monthly price in one month',
  },
  [CloudProvider.OVH]: {
    capsAtMonthlyPrice: false,
    vat: 'excluded',
    billedAs: 'Billed by the hour, with no monthly cap',
  },
};

export function billingOf(provider: string): ProviderBilling | null {
  return PROVIDER_BILLING[provider] ?? null;
}
