import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsString,
  IsUrl,
  IsOptional,
  IsArray,
  IsBoolean,
} from 'class-validator';

export class CreateInferenceConnectionDto {
  @ApiProperty({ description: 'Display label, e.g. "OpenAI (prod)"' })
  @IsNotEmpty()
  @IsString()
  label: string;

  @ApiProperty({
    description: 'OpenAI-compatible base URL, e.g. https://api.openai.com/v1',
  })
  @IsUrl({ require_tld: false })
  baseUrl: string;

  @ApiProperty({ description: 'API key for the endpoint' })
  @IsNotEmpty()
  @IsString()
  apiKey: string;

  @ApiPropertyOptional({ type: [String], description: 'Curated model ids' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  models?: string[];

  @ApiPropertyOptional({ description: 'Make this the default connection' })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
