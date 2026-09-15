import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';

export class EnsureByosVNetDto {
  @ApiPropertyOptional({
    description:
      'Range for the network Flui builds, if the default would collide with ' +
      'something you already run. Not a description of a network you have: ' +
      'Flui never infers one from an address a machine happens to carry.',
    example: '10.250.0.0/16',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9a-fA-F:.]+\/\d{1,3}$/, {
    message: 'ipRange must be a CIDR, e.g. 10.0.0.0/24',
  })
  ipRange?: string;
}
