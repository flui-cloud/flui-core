import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
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

export class MessagingPublishDto {
  @ApiProperty({ description: 'Subject / routing key to publish to.' })
  @IsString()
  @MaxLength(255)
  subject!: string;

  @ApiProperty({ description: 'Message payload (UTF-8 text).' })
  @IsString()
  @MaxLength(1_000_000)
  payload!: string;

  @ApiPropertyOptional({
    description: 'Optional message headers.',
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  @IsOptional()
  @IsObject()
  headers?: Record<string, string>;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  readOnly?: boolean;
}

export class MessagingPeekDto {
  @ApiProperty({ description: 'Stream to peek messages from.' })
  @IsString()
  @MaxLength(255)
  stream!: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({
    minimum: 1,
    description: 'Sequence to start from (default: stream tail / most recent).',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  startSeq?: number;
}

export class MessagingCreateStreamDto {
  @ApiProperty({ description: 'Stream name (no spaces or dots).' })
  @IsString()
  @MaxLength(255)
  name!: string;

  @ApiProperty({
    description: 'Subjects the stream captures, e.g. ["orders.>"].',
    type: [String],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(255, { each: true })
  subjects!: string[];

  @ApiPropertyOptional({ enum: ['file', 'memory'], default: 'file' })
  @IsOptional()
  @IsIn(['file', 'memory'])
  storage?: 'file' | 'memory';

  @ApiPropertyOptional({ enum: ['limits', 'workqueue', 'interest'] })
  @IsOptional()
  @IsIn(['limits', 'workqueue', 'interest'])
  retention?: 'limits' | 'workqueue' | 'interest';

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxMsgs?: number;

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxBytes?: number;

  @ApiPropertyOptional({
    minimum: 1,
    description: 'Max message age in seconds.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxAgeSeconds?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  readOnly?: boolean;
}
