import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import { PostgresHaDurability } from '../utils/cnpg-cluster.core';

export class ActivateDatabaseHaDto {
  @ApiPropertyOptional({
    enum: ['required', 'preferred'],
    default: 'required',
    description:
      '`required`: with no copy able to confirm, writes wait, and no confirmed write is ever lost. `preferred`: writes go on alone while no copy is reachable and the copies catch up later.',
  })
  @IsOptional()
  @IsIn(['required', 'preferred'])
  durability?: PostgresHaDurability;

  @ApiPropertyOptional({
    default: false,
    description:
      'Accept a region Flui has not validated for high availability. Its three locations are then treated as equal, with no promise about how far apart they are.',
  })
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}
