import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { USER_KIND, UserKind } from '../entities/user.entity';

export class ListIdentityUsersQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 500, default: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;

  @ApiPropertyOptional({ minimum: 0, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;

  @ApiPropertyOptional({ description: 'Substring filter on email' })
  @IsOptional()
  @IsString()
  emailContains?: string;

  @ApiPropertyOptional({
    enum: Object.values(USER_KIND),
    description: 'Only visitors of the demo, or only everybody else',
  })
  @IsOptional()
  @IsIn(Object.values(USER_KIND))
  kind?: UserKind;
}
