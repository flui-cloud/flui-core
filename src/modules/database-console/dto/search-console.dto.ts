import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { DbAssistDto } from './db-assist.dto';
import { RawRestMethod } from '../engine/raw-rest';

/** NL→query-DSL copilot request. Inherits prompt/conversation/model selection. */
export class SearchAssistDto extends DbAssistDto {
  /** Active index — scopes the data-blind structure context (field paths/types). */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  index?: string;
}

export class SearchIndexRefDto {
  @ApiProperty()
  @IsString()
  @MaxLength(255)
  index!: string;
}

export class SearchQueryDto {
  @ApiProperty()
  @IsString()
  @MaxLength(255)
  index!: string;

  @ApiPropertyOptional({
    description:
      'Raw query-DSL body (e.g. { query: { match: { title: "x" } } }). Defaults to match_all.',
  })
  @IsOptional()
  @IsObject()
  body?: Record<string, unknown>;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  from?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  size?: number;
}

export class SearchCountDto {
  @ApiProperty()
  @IsString()
  @MaxLength(255)
  index!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  body?: Record<string, unknown>;
}

const RAW_METHODS: RawRestMethod[] = [
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'HEAD',
  'PATCH',
];

/** Dev Tools console: one raw REST call. `readOnly` defaults to true (gate on). */
export class SearchRawDto {
  @ApiProperty({ enum: RAW_METHODS })
  @IsIn(RAW_METHODS)
  method!: RawRestMethod;

  @ApiProperty({ description: 'Path under the REST root, e.g. /_cat/indices' })
  @IsString()
  @MaxLength(2000)
  path!: string;

  @ApiPropertyOptional({
    description: 'JSON body (object) or NDJSON string for _bulk.',
  })
  @IsOptional()
  body?: unknown;

  @ApiPropertyOptional({
    description: 'When true (default) mutating requests are rejected.',
  })
  @IsOptional()
  @IsBoolean()
  readOnly?: boolean;
}
