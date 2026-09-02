import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';
import { IdentityRole } from '../entities/user.entity';
import { IdentityUser } from '../interfaces/identity-directory.interface';

/**
 * `IdentityUser` wrapped as a real DTO class: a plain interface carries no
 * `@ApiProperty`/`@Sensitivity` metadata for the sentinel or the interceptor
 * to find, so `email` shipped with no mechanism able to see it. Shape and
 * classification only — the fields are the directory's own, unchanged.
 */
export class IdentityUserResponseDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  id: string;

  @Sensitivity(Sensitivity.TENANT_IDENTITY)
  @ApiProperty()
  email: string;

  // Not `tenant-identity`: that category covers emails and org/tenant names,
  // not personal given/family names.
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional()
  firstName?: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional()
  lastName?: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ enum: IdentityRole })
  role: IdentityRole;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    description: "Provider account state, e.g. 'active'.",
  })
  state?: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description: 'True for the account seeded at install time.',
  })
  isBootstrapAdmin: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'True for a provider-internal service account, never a person.',
  })
  isSystemUser: boolean;

  constructor(user: IdentityUser) {
    this.id = user.id;
    this.email = user.email;
    this.firstName = user.firstName;
    this.lastName = user.lastName;
    this.role = user.role;
    this.state = user.state;
    this.isBootstrapAdmin = user.isBootstrapAdmin;
    this.isSystemUser = user.isSystemUser;
  }
}
