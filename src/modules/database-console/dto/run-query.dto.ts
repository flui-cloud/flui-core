import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class RunQueryDto {
  @IsString()
  @IsNotEmpty()
  sql: string;

  /** Defaults to true — writes are rejected by the DB until per-user roles land. */
  @IsOptional()
  @IsBoolean()
  readOnly?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000)
  limit?: number;
}
