import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { CloudProvider } from '../../providers/enums/cloud-provider.enum';
import { AssistTurnDto } from './db-assist.dto';

export class FulltextSearchDto {
  @ApiProperty({ description: 'Index uid to search.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  index!: string;

  @ApiPropertyOptional({
    description: 'Query text (empty = match everything).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  q?: string;

  @ApiPropertyOptional({
    description: 'Filter expression, e.g. `genre = horror`.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  filter?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 20 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ minimum: 0, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  offset?: number;
}

export class FulltextRawDto {
  @ApiProperty({ enum: ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'PATCH'] })
  @IsIn(['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'PATCH'])
  method!: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD' | 'PATCH';

  @ApiProperty({
    description: 'Path under the engine REST root, e.g. /indexes.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  path!: string;

  @ApiPropertyOptional({ description: 'JSON body.' })
  @IsOptional()
  body?: unknown;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  readOnly?: boolean;
}

export class FulltextAssistDto {
  @ApiProperty({ description: 'Natural-language request.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  prompt!: string;

  @ApiPropertyOptional({
    description: 'Active index for context (search copilot).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  index?: string;

  @ApiPropertyOptional({ type: () => [AssistTurnDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => AssistTurnDto)
  conversation?: AssistTurnDto[];

  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @IsEnum(CloudProvider)
  provider?: CloudProvider;

  @IsOptional()
  @IsUUID()
  connectionId?: string;
}
