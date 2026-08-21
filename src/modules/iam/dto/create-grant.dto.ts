import { IsIn, IsObject, IsOptional, IsString } from 'class-validator';
import {
  IamPrincipalType,
  IamScopeType,
  IamSelector,
} from '../interfaces/iam.types';
import { ASSIGNABLE_ROLE_KEYS } from '../constants/iam-roles';

export class CreateGrantDto {
  @IsIn(['user', 'group', 'service_account'])
  principalType: IamPrincipalType;

  @IsString()
  principalRef: string;

  // The enum comes from the role definitions, so a role added to the catalog
  // reaches the wire by being declared assignable — and the two the platform
  // assigns itself stay out without a second list to remember.
  @IsIn(ASSIGNABLE_ROLE_KEYS)
  role: string;

  @IsIn(['global', 'section', 'cluster', 'selector'])
  scopeType: IamScopeType;

  @IsOptional()
  @IsString()
  scopeRef?: string;

  @IsOptional()
  @IsObject()
  selector?: IamSelector;
}
