import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, Matches } from 'class-validator';
import { VNetImplementation } from '../../vnets/entities/vnet.entity';

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

  @ApiPropertyOptional({
    description:
      'Who builds the network. `provider-native` (the default) records one ' +
      'the operator already wired; `wireguard` has Flui build it and assign ' +
      'every node an address on it — for an estate whose machines share no ' +
      'network, where pod traffic would otherwise cross the internet in clear.',
    enum: VNetImplementation,
    example: VNetImplementation.WIREGUARD,
  })
  @IsOptional()
  @IsEnum(VNetImplementation)
  implementation?: VNetImplementation;
}
