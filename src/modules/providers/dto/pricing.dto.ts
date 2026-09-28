// Generic DTO for pricing - no dependencies on other modules
export class PricingQueryDto {
  region?: string;
  nodeSize?: string;
}

export class PriceDetailDto {
  net: string;
  gross: string;
}

export class LocationPriceDto {
  location: string;
  priceHourly: PriceDetailDto;
  priceMonthly: PriceDetailDto;
}

export class ServerTypePricingDto {
  id: string;
  name: string;
  prices: LocationPriceDto[];
}

export class PricingDto {
  provider: string;
  currency: string;
  vatRate: string;
  serverTypes: ServerTypePricingDto[];
  volumePerGbMonth?: PriceDetailDto;
}
