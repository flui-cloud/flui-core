import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import {
  IamPrincipalType,
  IamScopeType,
  IamSelector,
} from '../interfaces/iam.types';
import { ASSIGNABLE_ROLE_KEYS } from '../constants/iam-roles';

// kind: AccessPolicy wire shape — nested form of the flat RoleBinding columns.
export class PolicyPrincipalDto {
  @IsIn(['user', 'group', 'service_account'])
  type: IamPrincipalType;

  @IsString()
  ref: string;
}

export class PolicyScopeDto {
  @IsIn(['global', 'section', 'cluster', 'selector'])
  type: IamScopeType;

  @IsOptional()
  @IsString()
  section?: string;

  @IsOptional()
  @IsString()
  cluster?: string;

  @IsOptional()
  @IsObject()
  selector?: IamSelector;
}

export class PolicyBindingDto {
  @ValidateNested()
  @Type(() => PolicyPrincipalDto)
  principal: PolicyPrincipalDto;

  @IsIn(ASSIGNABLE_ROLE_KEYS)
  role: string;

  @ValidateNested()
  @Type(() => PolicyScopeDto)
  scope: PolicyScopeDto;
}

export class PolicySpecDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PolicyBindingDto)
  bindings: PolicyBindingDto[];
}

export class ApplyPolicyDto {
  @IsOptional()
  @IsString()
  apiVersion?: string;

  @IsOptional()
  @IsString()
  kind?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  @ValidateNested()
  @Type(() => PolicySpecDto)
  spec: PolicySpecDto;

  /** When true, delete existing bindings absent from this policy (full sync). */
  @IsOptional()
  @IsBoolean()
  prune?: boolean;
}

export interface AccessPolicyDoc {
  apiVersion: string;
  kind: 'AccessPolicy';
  metadata: { name: string };
  spec: { bindings: PolicyBindingDto[] };
}

export interface ApplyPolicyResult {
  created: number;
  unchanged: number;
  deleted: number;
  desired: number;
}
