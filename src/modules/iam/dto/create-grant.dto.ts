import { IsIn, IsObject, IsOptional, IsString } from 'class-validator';
import {
  IamPrincipalType,
  IamScopeType,
  IamSelector,
} from '../interfaces/iam.types';

export class CreateGrantDto {
  @IsIn(['user', 'group', 'service_account'])
  principalType: IamPrincipalType;

  @IsString()
  principalRef: string;

  @IsIn(['viewer', 'editor', 'manager'])
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
