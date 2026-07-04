import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { DemoProvisionMode } from '../enums/demo.enum';

export class UpdateDemoConfigDto {
  @IsOptional()
  @IsEnum(DemoProvisionMode)
  provisionMode?: DemoProvisionMode;

  @IsOptional()
  @IsUUID()
  appId?: string;

  @IsOptional()
  @IsUUID()
  dbAppId?: string;

  @IsOptional()
  @IsUUID()
  clusterAId?: string;

  @IsOptional()
  @IsUUID()
  clusterBId?: string;

  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true })
  probeUrl?: string;

  @IsOptional()
  @IsInt()
  @Min(500)
  @Max(60000)
  probeIntervalMs?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1440)
  intervalMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(120)
  drainMinutes?: number;

  @IsOptional()
  @IsString()
  stagingMode?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
