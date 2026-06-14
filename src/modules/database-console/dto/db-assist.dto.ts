import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { CloudProvider } from '../../providers/enums/cloud-provider.enum';

export class AssistTurnDto {
  @IsIn(['user', 'assistant'])
  role: 'user' | 'assistant';

  @IsString()
  @MaxLength(8000)
  content: string;
}

export class DbAssistDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  prompt: string;

  /** Prior turns for context. Never carries result rows — UI sends text only. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => AssistTurnDto)
  conversation?: AssistTurnDto[];

  // Model selection — same surface as the assistant; omit all for default (auto).
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
