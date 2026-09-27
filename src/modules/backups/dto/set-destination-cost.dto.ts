import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';
import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, Min, ValidateIf } from 'class-validator';

export class SetDestinationCostDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    nullable: true,
    description:
      'What this storage costs, in euro cents per GB per month (e.g. 1.606). null goes back to the published list price, when Flui has one for the provider.',
  })
  @ValidateIf((_o, v) => v !== null)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  costPerGbMonthCents: number | null;
}
