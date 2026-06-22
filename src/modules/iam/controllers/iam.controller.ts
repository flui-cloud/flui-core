import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { IamService } from '../services/iam.service';
import { AccessPolicyService } from '../services/access-policy.service';
import { RequirePermission } from '../decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../constants/iam-permissions';
import { CreateGrantDto } from '../dto/create-grant.dto';
import { CreateGroupDto } from '../dto/create-group.dto';
import { ApplyPolicyDto } from '../dto/access-policy.dto';
import { RequireSection } from '../decorators/require-section.decorator';

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
  applyPolicy(@Body() dto: ApplyPolicyDto) {
    return this.policy.apply(dto);
  }

  @Get('roles')
  roles() {
    return this.iam.listRoles();
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
  createGrant(@Body() dto: CreateGrantDto) {
    return this.iam.createGrant(dto);
  }

  @Delete('grants/:id')
  @RequirePermission(IAM_PERMISSION.IAM_ASSIGN_ROLE)
  deleteGrant(@Param('id') id: string) {
    return this.iam.deleteGrant(id);
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
