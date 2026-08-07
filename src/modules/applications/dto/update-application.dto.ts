import {
  IsString,
  IsOptional,
  IsEnum,
  IsInt,
  IsArray,
  IsObject,
  IsBoolean,
  Min,
  Max,
  ValidateNested,
  MaxLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ApplicationExposure } from '../enums/application-exposure.enum';

class EnvVarDto {
  @IsString()
  name: string;

  @IsString()
  value: string;

  @IsOptional()
  secret?: boolean;
}

class ResourceLimitDto {
  @IsOptional()
  @IsString()
  request?: string;

  @IsOptional()
  @IsString()
  limit?: string;
}

class ApplicationResourcesDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => ResourceLimitDto)
  cpu?: ResourceLimitDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ResourceLimitDto)
  memory?: ResourceLimitDto;
}

class ApplicationScalingDto {
  enabled: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  minReplicas?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxReplicas?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  targetCPU?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  targetMemory?: number;
}

export class UpdateApplicationDto {
  @ApiPropertyOptional({ description: 'Updated name' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({ description: 'Updated description' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ description: 'Updated source configuration' })
  @IsOptional()
  @IsObject()
  sourceConfig?: Record<string, any>;

  @ApiPropertyOptional({
    type: [EnvVarDto],
    description: 'Updated environment variables',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EnvVarDto)
  env?: EnvVarDto[];

  @ApiPropertyOptional({ description: 'Updated CPU and memory limits' })
  @IsOptional()
  @ValidateNested()
  @Type(() => ApplicationResourcesDto)
  resources?: ApplicationResourcesDto;

  @ApiPropertyOptional({ description: 'Updated autoscaling configuration' })
  @IsOptional()
  @ValidateNested()
  @Type(() => ApplicationScalingDto)
  scaling?: ApplicationScalingDto;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @IsInt()
  @Min(0)
  replicas?: number;

  @ApiPropertyOptional({ example: 3000 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @ApiPropertyOptional({
    description:
      'Override the auto-detected container start command. Set to null to reset to auto-detection.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  startCommand?: string;

  @ApiPropertyOptional({ description: 'K8s-style labels' })
  @IsOptional()
  @IsObject()
  labels?: Record<string, string>;

  @ApiPropertyOptional({ description: 'Flexible metadata' })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, string>;

  @ApiPropertyOptional({
    enum: ApplicationExposure,
    description:
      'Switch the app between public and internal exposure. Moving to "internal" requires that the app has no AppEndpoint attached (delete the endpoint first). Moving to "public" does NOT automatically create an endpoint — call POST /clusters/:id/app-endpoints afterwards to attach one.',
  })
  @IsOptional()
  @IsEnum(ApplicationExposure)
  exposure?: ApplicationExposure;

  @ApiPropertyOptional({
    description:
      'Enable/disable continuous auto-deploy on push for this git_build app. ' +
      'When true, a successful CI build on a new commit automatically rolls out ' +
      'the new image; when false, images are only recorded for manual deploy.',
  })
  @IsOptional()
  @IsBoolean()
  deployOnPush?: boolean;
}
