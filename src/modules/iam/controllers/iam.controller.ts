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
import { ApiOperation, ApiResponse } from '@nestjs/swagger';
import { IamService } from '../services/iam.service';
import { AccessPolicyService } from '../services/access-policy.service';
import { AccessDeltaService } from '../services/access-delta.service';
import { RequirePermission } from '../decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../constants/iam-permissions';
import { CreateGrantDto } from '../dto/create-grant.dto';
import { CreateGroupDto } from '../dto/create-group.dto';
import { ApplyPolicyDto } from '../dto/access-policy.dto';
import { AccessDeltaDto, AccessPreviewDto } from '../dto/access-delta.dto';
import { RequireSection } from '../decorators/require-section.decorator';
import { principalOf } from '../interfaces/iam.types';

@Controller('iam')
@RequireSection('access')
export class IamController {
  constructor(
    private readonly iam: IamService,
    private readonly policy: AccessPolicyService,
    private readonly delta: AccessDeltaService,
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

  /**
   * The three reads the access screen is built from — the grant graph, the
   * resources a selector can name, and the principals a grant can address.
   *
   * `iam:read-access` and not `iam:assign-role`: describing who can reach what
   * is a narrower act than deciding it, and only the narrow half can be lent to
   * an agent credential.
   *
   * They move together and never one at a time — a screen that reads three
   * routes under two permissions shows half a page and an error. Measured, this
   * takes nothing from anybody and gives nobody a screen they did not have:
   * `@RequireSection('access')` on the class still admits only `full`, which is
   * `iam:assign-role` at global scope, and every role holding it holds
   * `iam:read-access` too; a sandbox guest is answered from the example world
   * before either guard runs. What changes is the credential ceiling — a key
   * carrying `mcp:iam:read` now reaches them, which is the whole reason
   * `iam:read-access` was minted.
   */
  @Get('resources')
  @RequirePermission(IAM_PERMISSION.IAM_READ_ACCESS)
  listResources() {
    return this.iam.listResources();
  }

  @Get('principals')
  @RequirePermission(IAM_PERMISSION.IAM_READ_ACCESS)
  listPrincipals() {
    return this.iam.listPrincipals();
  }

  @Get('grants')
  @RequirePermission(IAM_PERMISSION.IAM_READ_ACCESS)
  listGrants() {
    return this.iam.listGrants();
  }

  /**
   * What removing this grant would take away from whoever holds it.
   *
   * A GET, and answerable without changing anything, because the warning is
   * only useful *before*: a person who has already pressed Remove is being
   * informed, not asked. `iam:read-access` and not `iam:assign-role` — reading
   * who can reach what is a narrower act than deciding it, and only the narrow
   * half can be lent to an agent credential.
   */
  @Get('grants/:id/revocation-preview')
  @RequirePermission(IAM_PERMISSION.IAM_READ_ACCESS)
  @ApiOperation({
    summary: 'What the holder of this grant would stop being able to reach',
    description:
      'Read-only. `summary` is the one sentence every surface shows. Read ' +
      '`coverage` before believing an empty list: `snapshot` means the lists ' +
      'also cover whatever matches the scope later, and `unknown` means the ' +
      'applications could not be read — never that there are none.',
  })
  @ApiResponse({ status: 200, type: AccessDeltaDto })
  @ApiResponse({ status: 404, description: 'Grant not found' })
  revocationPreview(@Param('id') id: string): Promise<AccessDeltaDto> {
    return this.delta.previewRevocation(id);
  }

  /**
   * The same question about a change that has not been made: add these
   * bindings, drop those, and say what moves.
   *
   * One shape for all three verbs the warning has to cover — conferring is
   * `add`, revoking is `removeGrantIds`, changing a role is both — because
   * that is how the screens do it, and asking as two questions would report two
   * halves of a change as two losses.
   */
  @Post('access-preview')
  @RequirePermission(IAM_PERMISSION.IAM_READ_ACCESS)
  @ApiOperation({
    summary: 'What a hypothetical access change would take away',
    description: 'Writes nothing. Same body as the delta on grant/revoke.',
  })
  @ApiResponse({ status: 200, type: AccessDeltaDto })
  accessPreview(@Body() dto: AccessPreviewDto): Promise<AccessDeltaDto> {
    return this.delta.preview(dto);
  }

  /**
   * Create a grant, and say what it changed for the person who got it.
   *
   * `delta` is additive on the existing shape rather than a wrapper around it:
   * every field the binding had is still where it was, so a client that has not
   * been taught about the warning keeps working — it simply does not show one.
   */
  @Post('grants')
  @RequirePermission(IAM_PERMISSION.IAM_ASSIGN_ROLE)
  async createGrant(@Body() dto: CreateGrantDto, @Req() req: Request) {
    const target = { type: dto.principalType, ref: dto.principalRef };
    const before = await this.delta.resolve(target);
    const grant = await this.iam.createGrant(dto, principalOf(req));
    return { ...grant, delta: await this.delta.since(target, before, [grant]) };
  }

  /** Remove a grant, and say what its holder stopped being able to reach. */
  @Delete('grants/:id')
  @RequirePermission(IAM_PERMISSION.IAM_ASSIGN_ROLE)
  async deleteGrant(@Param('id') id: string, @Req() req: Request) {
    const existing = await this.iam.getGrant(id);
    const target = {
      type: existing.principalType,
      ref: existing.principalRef,
    };
    const before = await this.delta.resolve(target);
    await this.iam.deleteGrant(id, principalOf(req));
    return {
      ...existing,
      delta: await this.delta.since(target, before, [existing]),
    };
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
