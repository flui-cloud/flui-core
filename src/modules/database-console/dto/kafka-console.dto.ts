import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { CloudProvider } from '../../providers/enums/cloud-provider.enum';
import { AssistTurnDto } from './db-assist.dto';

export class KafkaRunDto {
  @ApiProperty({ description: 'A kafka-shell command, e.g. "topics list".' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  command!: string;

  @ApiPropertyOptional({
    description: 'When true (default) only read commands are allowed.',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  readOnly?: boolean;
}

export class KafkaAssistDto {
  @ApiProperty({
    description: 'Natural-language request for a kafka-shell command.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  prompt!: string;

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
