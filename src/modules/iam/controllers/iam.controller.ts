import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { IamService } from '../services/iam.service';
import { AccessPolicyService } from '../services/access-policy.service';
import { RequirePermission } from '../decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../constants/iam-permissions';
import { CreateGrantDto } from '../dto/create-grant.dto';
import { CreateGroupDto } from '../dto/create-group.dto';
import { ApplyPolicyDto } from '../dto/access-policy.dto';
import { RequireSection } from '../decorators/require-section.decorator';
import { principalOf } from '../interfaces/iam.types';

@Controller('iam')
@RequireSection('access')
export class IamController {
  constructor(
    private readonly iam: IamService,
    private readonly policy: AccessPolicyService,
  ) {}

  /** Export all RoleBindings as a kind: AccessPolicy document (drift/audit snapshot). */
  @Get('policy')
  @RequirePermission(IAM_PERMISSION.IAM_ASSIGN_ROLE)
  exportPolicy() {
    return this.policy.export();
  }

  /** Apply an AccessPolicy: idempotent upsert of bindings; `prune` for full sync. */
  @Post('apply')
  @RequirePermission(IAM_PERMISSION.IAM_ASSIGN_ROLE)
  applyPolicy(@Body() dto: ApplyPolicyDto, @Req() req: Request) {
    return this.policy.apply(dto, principalOf(req));
  }

  /**
   * The role catalog, each entry saying whether this caller may confer it.
   *
   * The screen builds its role pickers from this list. Before `grantable`
   * existed it offered all of them, including the two the platform assigns
   * itself — so choosing "Sandbox guest" and pressing Save answered 400.
   */
  @Get('roles')
  roles(@Req() req: Request) {
    return this.iam.listRolesFor(principalOf(req));
  }

  @Get('resources')
  @RequirePermission(IAM_PERMISSION.IAM_ASSIGN_ROLE)
  listResources() {
    return this.iam.listResources();
  }

  @Get('principals')
  @RequirePermission(IAM_PERMISSION.IAM_ASSIGN_ROLE)
  listPrincipals() {
    return this.iam.listPrincipals();
  }

  @Get('grants')
  @RequirePermission(IAM_PERMISSION.IAM_ASSIGN_ROLE)
  listGrants() {
    return this.iam.listGrants();
  }

  @Post('grants')
  @RequirePermission(IAM_PERMISSION.IAM_ASSIGN_ROLE)
  createGrant(@Body() dto: CreateGrantDto, @Req() req: Request) {
    return this.iam.createGrant(dto, principalOf(req));
  }

  @Delete('grants/:id')
  @RequirePermission(IAM_PERMISSION.IAM_ASSIGN_ROLE)
  deleteGrant(@Param('id') id: string, @Req() req: Request) {
    return this.iam.deleteGrant(id, principalOf(req));
  }

  @Get('groups')
  @RequirePermission(IAM_PERMISSION.IAM_ASSIGN_ROLE)
  listGroups() {
    return this.iam.listGroups();
  }

  @Post('groups')
  @RequirePermission(IAM_PERMISSION.IAM_ASSIGN_ROLE)
  createGroup(@Body() dto: CreateGroupDto) {
    return this.iam.createGroup(dto);
  }

  @Delete('groups/:name')
  @RequirePermission(IAM_PERMISSION.IAM_ASSIGN_ROLE)
  deleteGroup(@Param('name') name: string) {
    return this.iam.deleteGroup(name);
  }

  @Post('groups/:name/members/:email')
  @RequirePermission(IAM_PERMISSION.IAM_ASSIGN_ROLE)
  addMember(@Param('name') name: string, @Param('email') email: string) {
    return this.iam.addGroupMember(name, email);
  }

  @Delete('groups/:name/members/:email')
  @RequirePermission(IAM_PERMISSION.IAM_ASSIGN_ROLE)
  removeMember(@Param('name') name: string, @Param('email') email: string) {
    return this.iam.removeGroupMember(name, email);
  }
}
