import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';
import { HA_NODE_ROLES, HaNodeRole } from '../utils/ha-node-role';

export class AddHaNodeDto {
  @ApiProperty({
    enum: HA_NODE_ROLES,
    description:
      '`server`: a node that also runs the control plane and holds a vote, one per location. `data-host`: a node that takes applications in a location for data, where copies of databases and volumes live.',
  })
  @IsIn(HA_NODE_ROLES as unknown as string[])
  role!: HaNodeRole;

  @ApiProperty({
    description:
      'The location to add it in, one the cluster view lists under `missing` for that role (for example `hel1`).',
  })
  @IsString()
  zone!: string;

  @ApiPropertyOptional({
    description: "The machine size to buy. Omitted: the cluster's own size.",
  })
  @IsOptional()
  @IsString()
  serverType?: string;

  @ApiPropertyOptional({
    default: false,
    description:
      'Accept a region Flui has not validated for high availability; its three locations are treated as equal.',
  })
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}
