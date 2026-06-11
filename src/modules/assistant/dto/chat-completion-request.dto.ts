import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { CloudProvider } from '../../providers/enums/cloud-provider.enum';
import { ChatMessageDto } from './chat-message.dto';

export class ChatCompletionRequestDto {
  @ApiProperty({ type: [ChatMessageDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => ChatMessageDto)
  messages: ChatMessageDto[];

  @ApiPropertyOptional({
    description:
      'Model id; defaults to the first model on the resolved endpoint',
  })
  @IsOptional()
  @IsString()
  model?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 2 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(2)
  temperature?: number;

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  maxTokens?: number;

  @ApiPropertyOptional({
    enum: CloudProvider,
    description:
      'Route to a native inference provider; omit to use the default endpoint',
  })
  @IsOptional()
  @IsEnum(CloudProvider)
  provider?: CloudProvider;

  @ApiPropertyOptional({
    description: 'Route to a BYO inference connection by id',
  })
  @IsOptional()
  @IsUUID()
  connectionId?: string;
}
