import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { SurfaceSnapshot } from '@flui-cloud/semantic-surface';
import { CloudProvider } from '../../providers/enums/cloud-provider.enum';
import { ToolCall } from '../interfaces/chat-completion';

/** A conversation message echoed by the client (user, assistant tool-calls, or tool results). */
export class AgentMessageDto {
  @ApiProperty()
  @IsString()
  role: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  content?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  tool_calls?: ToolCall[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  tool_call_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;
}

export class AgentRequestDto {
  @ApiProperty({ type: [AgentMessageDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => AgentMessageDto)
  messages: AgentMessageDto[];

  @ApiPropertyOptional({
    description: 'Tool-call ids the user approved (to resume a pending action)',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  approvedToolCallIds?: string[];

  @ApiPropertyOptional()
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

  @ApiPropertyOptional({ enum: CloudProvider })
  @IsOptional()
  @IsEnum(CloudProvider)
  provider?: CloudProvider;

  @ApiPropertyOptional({
    description: 'Route to a BYO inference connection by id',
  })
  @IsOptional()
  @IsUUID()
  connectionId?: string;

  /**
   * A Semantic Surface snapshot of the page the user is chatting from (spec
   * §11.1). Untyped past @IsObject() on purpose: it crosses a trust boundary,
   * so schema and semantic validation happen in the service, which drops it
   * silently on any defect rather than 400ing a chat message over it.
   */
  @ApiPropertyOptional({
    type: Object,
    description:
      'Semantic Surface snapshot of the page the user is chatting from. Invalid or stale snapshots are silently dropped, never rejected.',
  })
  @IsOptional()
  @IsObject()
  surface?: SurfaceSnapshot;

  @ApiPropertyOptional({
    description:
      "The surface.revision in force when the message was sent, echoing the snapshot's own — a mismatch drops the snapshot.",
  })
  @IsOptional()
  @IsNumber()
  surfaceRevision?: number;
}
