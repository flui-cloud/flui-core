import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';
import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

export class GatewaySsoCodeDto {
  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER)
  @ApiProperty({
    description: 'The page on the route to return to after signing in.',
  })
  @IsString()
  @MaxLength(4096)
  returnUrl: string;
}
