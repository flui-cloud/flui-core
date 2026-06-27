import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';

export class EnsureByosVNetDto {
  @ApiPropertyOptional({
    description:
      'CIDR of the private network the nodes share. Omit to derive it from ' +
      'the cluster (existing declaration, or the /24 of the master private IP).',
    example: '10.0.0.0/24',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9a-fA-F:.]+\/\d{1,3}$/, {
    message: 'ipRange must be a CIDR, e.g. 10.0.0.0/24',
  })
  ipRange?: string;
}
