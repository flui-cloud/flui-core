import { Injectable, Logger } from '@nestjs/common';
import { ProviderFactory } from '../../../providers/core/factories/provider.factory';
import { CloudProvider } from '../../../providers/enums/cloud-provider.enum';
import { NodeSizeDto } from '../../../providers/dto/node-size.dto';
import { PricingDto } from '../../../providers/dto/pricing.dto';
import { NodeRate, PriceBasis, VolumeRate } from '../costs/cost-accrual';
import { VatSource, billingOf } from '../costs/provider-billing';

const CACHE_TTL_MS = 15 * 60 * 1000;
const VAT_FROM_ACCOUNT: VatSource = 'provider-account';

/** What a lifetime carries in `metadata.price` once priced. */
export interface StampedNodePrice {
  hourlyNet: number;
  hourlyGross: number | null;
  monthlyNet: number | null;
  monthlyGross: number | null;
  basis: PriceBasis;
  pricedAt: string;
}

export interface StampedVolumePrice {
  perGbMonthNet: number;
  perGbMonthGross: number | null;
  basis: PriceBasis;
  pricedAt: string;
}

export interface VatInfo {
  /** Whether the gross figures include VAT. False means every amount of this provider is excluding VAT. */
  included: boolean;
  /** The rate the provider applies to this account, when it states one. */
  ratePercent: string | null;
}

function num(value: string | undefined | null): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Prices for costs, read from the providers and nowhere else.
 *
 * A figure a provider does not publish is null, never a guess: no VAT rate for
 * a catalogue that prints none, no storage rate for a provider whose volumes
 * Flui cannot price.
 */
@Injectable()
export class CostRatesService {
  private readonly logger = new Logger(CostRatesService.name);
  private readonly catalogues = new Map<
    string,
    { fetchedAt: number; sizes: NodeSizeDto[] }
  >();
  private readonly pricing = new Map<
    string,
    { fetchedAt: number; pricing: PricingDto | null }
  >();

  constructor(private readonly providerFactory: ProviderFactory) {}

  isPriced(provider: string): boolean {
    if (!billingOf(provider)) return false;
    return (this.providerFactory.getSupportedProviders() as string[]).includes(
      provider,
    );
  }

  async vat(provider: string): Promise<VatInfo> {
    if (billingOf(provider)?.vat !== VAT_FROM_ACCOUNT) {
      return { included: false, ratePercent: null };
    }
    const pricing = await this.providerPricing(provider);
    const rate = num(pricing?.vatRate);
    return {
      included: true,
      ratePercent: rate === null ? null : String(Number(rate.toFixed(2))),
    };
  }

  /** The price stamped on a lifetime first, the list price today otherwise. */
  async nodeRate(
    provider: string,
    serverType: string,
    region: string | null | undefined,
    location: string | null | undefined,
    stamped?: StampedNodePrice | null,
  ): Promise<NodeRate | null> {
    if (stamped && Number.isFinite(stamped.hourlyNet)) {
      return {
        hourlyNet: stamped.hourlyNet,
        hourlyGross: stamped.hourlyGross ?? null,
        monthlyNet: stamped.monthlyNet ?? null,
        monthlyGross: stamped.monthlyGross ?? null,
        basis: stamped.basis ?? 'recorded',
      };
    }
    const list = await this.listNodePrice(
      provider,
      serverType,
      region,
      location,
    );
    return list ? { ...list, basis: 'list' } : null;
  }

  async volumeRate(
    provider: string,
    stamped?: StampedVolumePrice | null,
  ): Promise<VolumeRate | null> {
    if (stamped && Number.isFinite(stamped.perGbMonthNet)) {
      return {
        perGbMonthNet: stamped.perGbMonthNet,
        perGbMonthGross: stamped.perGbMonthGross ?? null,
      };
    }
    return this.listVolumePrice(provider);
  }

  async stampNode(
    provider: string,
    serverType: string,
    region: string | null | undefined,
    location: string | null | undefined,
    basis: PriceBasis,
  ): Promise<StampedNodePrice | null> {
    const list = await this.listNodePrice(
      provider,
      serverType,
      region,
      location,
    );
    return list ? { ...list, basis, pricedAt: new Date().toISOString() } : null;
  }

  async stampVolume(
    provider: string,
    basis: PriceBasis,
  ): Promise<StampedVolumePrice | null> {
    const list = await this.listVolumePrice(provider);
    return list ? { ...list, basis, pricedAt: new Date().toISOString() } : null;
  }

  private async listNodePrice(
    provider: string,
    serverType: string,
    region: string | null | undefined,
    location: string | null | undefined,
  ): Promise<Omit<NodeRate, 'basis'> | null> {
    const billing = billingOf(provider);
    if (!billing || !serverType || !this.isPriced(provider)) return null;
    const sizes = await this.catalogue(provider);
    const size = sizes.find(
      (s) => s.name === serverType || s.id === serverType,
    );
    if (!size?.prices?.length) return null;
    const price =
      (region ? size.prices.find((p) => p.location === region) : undefined) ??
      (location
        ? size.prices.find((p) => p.location === location)
        : undefined) ??
      size.prices[0];
    const hourlyNet = num(price.priceHourly?.net);
    if (hourlyNet === null) return null;
    const withVat = billing.vat === VAT_FROM_ACCOUNT;
    return {
      hourlyNet,
      hourlyGross: withVat ? num(price.priceHourly?.gross) : null,
      monthlyNet: num(price.priceMonthly?.net),
      monthlyGross: withVat ? num(price.priceMonthly?.gross) : null,
    };
  }

  /**
   * The provider's own storage price: from its pricing API where it has one,
   * else from the block-storage price its catalogue declares on network-disk
   * sizes. A provider with neither has volumes Flui does not price.
   */
  private async listVolumePrice(provider: string): Promise<VolumeRate | null> {
    const billing = billingOf(provider);
    if (!billing || !this.isPriced(provider)) return null;
    const pricing = await this.providerPricing(provider);
    const fromPricing = num(pricing?.volumePerGbMonth?.net);
    if (fromPricing !== null) {
      return {
        perGbMonthNet: fromPricing,
        perGbMonthGross:
          billing.vat === VAT_FROM_ACCOUNT
            ? num(pricing?.volumePerGbMonth?.gross)
            : null,
      };
    }
    const sizes = await this.catalogue(provider);
    const declared = num(
      sizes.find((s) => s.blockStoragePricePerGbMonthly)
        ?.blockStoragePricePerGbMonthly,
    );
    if (declared === null) return null;
    return { perGbMonthNet: declared, perGbMonthGross: null };
  }

  private async catalogue(provider: string): Promise<NodeSizeDto[]> {
    const cached = this.catalogues.get(provider);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.sizes;
    }
    let sizes: NodeSizeDto[] = [];
    try {
      const service = this.providerFactory.getProvider(
        provider as CloudProvider,
      );
      if (service.getNodeSizes) sizes = await service.getNodeSizes(false);
    } catch (err) {
      this.logger.warn(
        `Price list unavailable for ${provider}: ${(err as Error).message}`,
      );
      return cached?.sizes ?? [];
    }
    this.catalogues.set(provider, { fetchedAt: Date.now(), sizes });
    return sizes;
  }

  private async providerPricing(provider: string): Promise<PricingDto | null> {
    const cached = this.pricing.get(provider);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.pricing;
    }
    let pricing: PricingDto | null = null;
    try {
      const service = this.providerFactory.getProvider(
        provider as CloudProvider,
      );
      if (service.getPricing) pricing = await service.getPricing({});
    } catch (err) {
      this.logger.warn(
        `Pricing unavailable for ${provider}: ${(err as Error).message}`,
      );
      return cached?.pricing ?? null;
    }
    this.pricing.set(provider, { fetchedAt: Date.now(), pricing });
    return pricing;
  }
}
