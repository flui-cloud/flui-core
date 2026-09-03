import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';
import {
  IamPrincipalType,
  IamScopeType,
  IamSelector,
} from '../interfaces/iam.types';

/**
 * A choosable grantee for the "Who" picker — response shape for `GET /iam/principals`.
 * Previously returned as a bare `IamPrincipalOption[]` with no `@ApiResponse` type,
 * which made this route invisible to the mask interceptor: `ref` is an email for a
 * `user` principal and leaked in the clear regardless of mask mode. `ref` is classified
 * `TENANT_IDENTITY` unconditionally — it also covers `group`/`service_account` refs,
 * which are not personal data, but masking a non-sensitive ref when the toggle is on
 * costs nothing; leaving a real email unmasked costs a lot.
 */
export class IamPrincipalResponseDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  type: IamPrincipalType;

  @Sensitivity(Sensitivity.TENANT_IDENTITY)
  @ApiProperty()
  ref: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  displayName: string;
}

/**
 * `GET /iam/grants` and `GET /iam/grants/:id` — previously returned a bare
 * `IamRoleBindingEntity`/`[]` with no `@ApiResponse` type, same invisibility-to-the-
 * interceptor bug as `IamPrincipalResponseDto` above. This is the route the dashboard's
 * Access "Grants" tab reads `principal.ref` from — confirmed leaking real emails on
 * screen and into the Semantic Surface even with mask mode on, before this fix.
 */
export class IamRoleBindingResponseDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  id: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  principalType: IamPrincipalType;

  @Sensitivity(Sensitivity.TENANT_IDENTITY)
  @ApiProperty()
  principalRef: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  role: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  scopeType: IamScopeType;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({ nullable: true })
  scopeRef: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({ nullable: true })
  selector: IamSelector | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  createdAt: Date;
}

/**
 * `GET /iam/groups` — previously a bare `IamGroupEntity[]` with no `@ApiResponse`
 * type. `members` is a list of emails (symbolic membership, see IamGroupEntity's own
 * comment) — TENANT_IDENTITY, substituted element-wise like any other string array.
 */
export class IamGroupResponseDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  id: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  name: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({ nullable: true })
  description: string | null;

  @Sensitivity(Sensitivity.TENANT_IDENTITY)
  @ApiProperty({ type: [String] })
  members: string[];

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  createdAt: Date;
}
