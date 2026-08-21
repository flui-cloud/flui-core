import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import {
  ASSIGNABLE_IDENTITY_ROLES,
  AssignableIdentityRole,
} from '../constants/assignable-roles';

export class UpdateIdentityRoleDto {
  @ApiProperty({
    enum: ASSIGNABLE_IDENTITY_ROLES,
    description:
      'Platform admin is not conferrable here — see POST /auth/users.',
  })
  @IsIn([...ASSIGNABLE_IDENTITY_ROLES], {
    message: `role must be one of: ${ASSIGNABLE_IDENTITY_ROLES.join(', ')} — platform admin cannot be conferred through this route`,
  })
  role: AssignableIdentityRole;
}
