import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
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

export class DocCollectionsDto {
  @IsString()
  @IsNotEmpty()
  database: string;
}

export class DocFieldsDto {
  @IsString()
  @IsNotEmpty()
  database: string;

  @IsString()
  @IsNotEmpty()
  collection: string;
}

export class DocFindDto {
  @IsString()
  @IsNotEmpty()
  database: string;

  @IsString()
  @IsNotEmpty()
  collection: string;

  /** Mongo query filter; omitted/empty matches all. */
  @IsOptional()
  @IsObject()
  filter?: Record<string, unknown>;

  /**
   * Raw mongosh-syntax filter as typed in the Compass-style query bar, e.g.
   * `{ _id: ObjectId("…"), createdAt: { $gt: ISODate("…") } }`. Parsed
   * server-side (shell-bson-parser); takes precedence over `filter`.
   */
  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  filterText?: string;

  /** Mongo sort document, e.g. { createdAt: -1 }. */
  @IsOptional()
  @IsObject()
  sort?: Record<string, 1 | -1>;

  /** Raw mongosh-syntax sort; parsed server-side, precedence over `sort`. */
  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  sortText?: string;

  /** Field projection, e.g. { _id: 0, name: 1 }. */
  @IsOptional()
  @IsObject()
  projection?: Record<string, 0 | 1>;

  /** Raw mongosh-syntax projection; parsed server-side, precedence over `projection`. */
  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  projectionText?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  skip?: number;
}

export class DocCommandDto {
  @IsString()
  @IsNotEmpty()
  database: string;

  /** A Mongo command document, e.g. { find: "users", filter: { active: true } }. */
  @IsObject()
  command: Record<string, unknown>;

  /** Defaults to true — write commands are rejected unless explicitly disabled. */
  @IsOptional()
  @IsBoolean()
  readOnly?: boolean;
}

export class DocShellDto {
  /** Active database the statement runs against (overridden by `use <db>` client-side). */
  @IsString()
  @IsNotEmpty()
  database: string;

  /** A single mongosh statement, e.g. `db.users.find({ active: true }).limit(10)`. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(10_000)
  input: string;

  /** Defaults to true — write statements are rejected unless explicitly disabled. */
  @IsOptional()
  @IsBoolean()
  readOnly?: boolean;
}

export class DocAssistDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  prompt: string;

  /** Prior turns for context. Never carries result documents — UI sends text only. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => AssistTurnDto)
  conversation?: AssistTurnDto[];

  /** Active database — scopes the data-blind structure context (collection names). */
  @IsOptional()
  @IsString()
  database?: string;

  /** Active collection — adds its inferred field structure (paths + types, no values). */
  @IsOptional()
  @IsString()
  collection?: string;

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
