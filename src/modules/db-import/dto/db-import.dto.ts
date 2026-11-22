import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';
import { EXTERNAL_PG_SSL_MODES } from '../../db-lifecycle/utils/external-pg.core';
import { DbImportStatus } from '../entities/db-import.entity';

export class DbImportSourceDto {
  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER)
  @ApiProperty({ example: 'db.example.com' })
  @IsString()
  @MaxLength(253)
  host: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ example: 5432 })
  @IsInt()
  @Min(1)
  @Max(65535)
  port: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ example: 'shop' })
  @IsString()
  @MaxLength(63)
  database: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ example: 'replicator' })
  @IsString()
  @MaxLength(63)
  user: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ enum: EXTERNAL_PG_SSL_MODES, example: 'require' })
  @IsIn(EXTERNAL_PG_SSL_MODES)
  sslmode: (typeof EXTERNAL_PG_SSL_MODES)[number];
}

export class StartDbImportDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: DbImportSourceDto })
  @ValidateNested()
  @Type(() => DbImportSourceDto)
  source: DbImportSourceDto;

  @Sensitivity(Sensitivity.CREDENTIAL)
  @ApiProperty({
    description:
      'Password of the source user. Kept encrypted while the import runs and dropped when it ends.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  password: string;
}

export class DbImportViewDto {
  @Sensitivity(Sensitivity.PUBLIC) @ApiProperty() id: string;
  @Sensitivity(Sensitivity.PUBLIC) @ApiProperty() applicationId: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ enum: ['postgres', 'mariadb'] })
  engine: 'postgres' | 'mariadb';

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    enum: DbImportStatus,
    description:
      'checking: reading the source and copying the schema. copying: the tables are being copied. streaming: every table is copied and new changes follow; the switch is possible. cutting-over: waiting for the last changes, then detaching. completed, failed, aborted: ended.',
  })
  status: DbImportStatus;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: DbImportSourceDto })
  source: DbImportSourceDto;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ nullable: true, type: Number })
  tablesTotal: number | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ nullable: true, type: Number })
  tablesCopied: number | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    nullable: true,
    type: Number,
    description:
      'PostgreSQL: bytes of changes on the source not yet applied here.',
  })
  lagBytes: number | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'MariaDB: seconds this copy is behind the source.',
  })
  lagSeconds: number | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    type: [String],
    description:
      'PostgreSQL: tables without a primary key, given a full replica identity on the source for the import and set back at the end.',
  })
  tablesWithoutKey: string[];

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({ nullable: true, type: String })
  detail: string | null;

  @Sensitivity(Sensitivity.PUBLIC) @ApiProperty() createdAt: Date;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ nullable: true, type: Date })
  endedAt: Date | null;
}
