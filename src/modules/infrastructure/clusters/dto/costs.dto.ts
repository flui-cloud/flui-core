import { ApiProperty } from '@nestjs/swagger';
import { Sensitivity } from '../../../mask/decorators/sensitivity.decorator';

export class CostMonthDto {
  @ApiProperty({ example: '2026-09', description: 'Calendar month, UTC' })
  @Sensitivity(Sensitivity.PUBLIC)
  month: string;

  @ApiProperty({ description: 'The month now running' })
  @Sensitivity(Sensitivity.PUBLIC)
  current: boolean;

  @ApiProperty({
    example: 11.24,
    description: 'Spent in the month so far, excluding VAT',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  spentNet: number;

  @ApiProperty({
    nullable: true,
    example: 13.38,
    description:
      'Spent including VAT; null where the provider states no VAT rate',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  spentGross: number | null;

  @ApiProperty({
    nullable: true,
    example: 12.31,
    description:
      'Current month only: spent so far plus what runs now kept running to the end of the month, excluding VAT',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  forecastNet: number | null;

  @ApiProperty({ nullable: true, example: 14.65 })
  @Sensitivity(Sensitivity.PUBLIC)
  forecastGross: number | null;
}

export class CostClusterDto {
  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  clusterId: string;

  @ApiProperty({ example: 'control-cluster' })
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  clusterName: string;

  @ApiProperty({ nullable: true, example: 'fsn1' })
  @Sensitivity(Sensitivity.PUBLIC)
  region: string | null;

  @ApiProperty({
    description: 'The cluster was deleted; what it cost is still counted',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  removed: boolean;

  @ApiProperty({ type: [CostMonthDto] })
  @Sensitivity(Sensitivity.PUBLIC)
  months: CostMonthDto[];

  @ApiProperty({
    description: 'Machines and volumes in the window that Flui could not price',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  unpriced: number;

  @ApiProperty({
    description:
      'Machines and volumes priced at the list price of today because they started before Flui kept the price they were bought at',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  listPriced: number;
}

export class CostProviderDto {
  @ApiProperty({ example: 'hetzner' })
  @Sensitivity(Sensitivity.PUBLIC)
  provider: string;

  @ApiProperty({ description: 'Flui can read the prices of this provider' })
  @Sensitivity(Sensitivity.PUBLIC)
  priced: boolean;

  @ApiProperty({
    nullable: true,
    example:
      'Billed by the hour, never more than the monthly price in one month',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  billedAs: string | null;

  @ApiProperty({
    description:
      'Gross amounts include VAT at the rate the provider applies to the account',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  vatIncluded: boolean;

  @ApiProperty({ nullable: true, example: '19' })
  @Sensitivity(Sensitivity.PUBLIC)
  vatRatePercent: string | null;

  @ApiProperty({ type: [CostMonthDto] })
  @Sensitivity(Sensitivity.PUBLIC)
  months: CostMonthDto[];

  @ApiProperty({ type: [CostClusterDto] })
  @Sensitivity(Sensitivity.PUBLIC)
  clusters: CostClusterDto[];

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  unpriced: number;

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  listPriced: number;

  @ApiProperty({ nullable: true })
  @Sensitivity(Sensitivity.PUBLIC)
  note: string | null;
}

export class CostsResponseDto {
  @ApiProperty({ example: 'EUR' })
  @Sensitivity(Sensitivity.PUBLIC)
  currency: string;

  @ApiProperty({ example: ['2026-08', '2026-09'] })
  @Sensitivity(Sensitivity.PUBLIC)
  months: string[];

  @ApiProperty({
    type: [CostMonthDto],
    description:
      'All providers together, excluding VAT; gross only when every provider states its VAT',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  totals: CostMonthDto[];

  @ApiProperty({ type: [CostProviderDto] })
  @Sensitivity(Sensitivity.PUBLIC)
  providers: CostProviderDto[];

  @ApiProperty({
    nullable: true,
    description:
      'The first machine or volume Flui recorded; nothing before it is known',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  recordedSince: Date | null;

  @ApiProperty({ type: [String] })
  @Sensitivity(Sensitivity.PUBLIC)
  notes: string[];

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  calculatedAt: Date;
}
