import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';
import { UserEntity } from '../entities/user.entity';

export class BlockUserDto {
  @ApiPropertyOptional({
    description: 'Why, for the record and for whoever reads it later.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** A person's block state, as an administrator sees it. */
export class BlockedUserResponseDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  id: string;

  @Sensitivity(Sensitivity.TENANT_IDENTITY)
  @ApiProperty()
  email: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: String, nullable: true })
  blockedAt: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: String, nullable: true })
  blockedReason: string | null;

  constructor(user: UserEntity) {
    this.id = user.id;
    this.email = user.email;
    this.blockedAt = user.blockedAt ? user.blockedAt.toISOString() : null;
    this.blockedReason = user.blockedReason ?? null;
  }
}
