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

export class KvScanDto {
  /** SCAN cursor; '0' to start. */
  @IsString()
  cursor: string;

  @IsOptional()
  @IsString()
  match?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  count?: number;
}

export class KvReadKeyDto {
  @IsString()
  @IsNotEmpty()
  key: string;
}

export class KvCommandDto {
  /** Command + arguments, e.g. ["GET", "user:42"]. */
  @IsArray()
  args: (string | number)[];

  /** Defaults to true — write commands are rejected unless explicitly disabled. */
  @IsOptional()
  @IsBoolean()
  readOnly?: boolean;
}

export class KvAssistTurnDto {
  @IsIn(['user', 'assistant'])
  role: 'user' | 'assistant';

  @IsString()
  @MaxLength(8000)
  content: string;
}

export class KvAssistDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  prompt: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => KvAssistTurnDto)
  conversation?: KvAssistTurnDto[];

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
