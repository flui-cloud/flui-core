import { Injectable } from '@nestjs/common';
import { PricingDto, ServerTypePricingDto } from '../dto/pricing.dto';
import { CloudProvider } from '../enums/cloud-provider.enum';
import {
  GetPricing200ResponsePricing,
  GetPricing200ResponsePricingServerTypesInner,
} from 'src/modules/providers/implementations/hetzner/generated';
@Injectable()
export class PricingMapper {
  /**
   * Maps Hetzner pricing data to PricingDto
   * Optionally filters by region and nodeSize
   */
  mapHetznerPricingToDto(
    pricing: GetPricing200ResponsePricing,
    provider: CloudProvider,
    regionFilter?: string,
    nodeSizeFilter?: string,
  ): PricingDto {
    let serverTypes = pricing.server_types;

    // Filter by nodeSize (server type name)
    if (nodeSizeFilter) {
      serverTypes = serverTypes.filter(
        (st) => st.name.toLowerCase() === nodeSizeFilter.toLowerCase(),
      );
    }

    // Map server types and optionally filter prices by region
    const mappedServerTypes = serverTypes.map((st) =>
      this.mapServerTypePricing(st, regionFilter),
    );

    return {
      provider: provider.toLowerCase(),
      currency: pricing.currency,
      vatRate: pricing.vat_rate,
      serverTypes: mappedServerTypes,
      ...(pricing.volume?.price_per_gb_month
        ? {
            volumePerGbMonth: {
              net: pricing.volume.price_per_gb_month.net,
              gross: pricing.volume.price_per_gb_month.gross,
            },
          }
        : {}),
    };
  }

  /**
   * Maps a single server type pricing
   */
  private mapServerTypePricing(
    serverType: GetPricing200ResponsePricingServerTypesInner,
    regionFilter?: string,
  ): ServerTypePricingDto {
    let prices = serverType.prices;

    // Filter by region/location
    if (regionFilter) {
      prices = prices.filter(
        (p) => p.location.toLowerCase() === regionFilter.toLowerCase(),
      );
    }

    return {
      id: serverType.id.toString(),
      name: serverType.name,
      prices: prices.map((price) => ({
        location: price.location,
        priceHourly: {
          net: price.price_hourly.net,
          gross: price.price_hourly.gross,
        },
        priceMonthly: {
          net: price.price_monthly.net,
          gross: price.price_monthly.gross,
        },
      })),
    };
  }
}
