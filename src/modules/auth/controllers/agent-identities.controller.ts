import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { RequireSection } from '../../iam/decorators/require-section.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { principalFromUser } from '../../iam/interfaces/iam.types';
import { AgentIdentityService } from '../services/agent-identity.service';
import {
  expandPermissionGroups,
  groupsForScopes,
  isPermissionGroup,
} from '../constants/api-key-groups';
import { isGrantableScope, orderScopes } from '../constants/api-key-scopes';
import {
  AgentIdentityDto,
  AgentIdentityResultDto,
  CreateAgentIdentityDto,
} from '../dto/agent-identity.dto';

/**
 * The door onto `AgentIdentityService` — an agent with an identity of its own
 * in the provider, instead of a key cut from a person's session.
 *
 * It sits beside `auth/users` and takes the same two permissions, in the same
 * split: reading is `iam:assign-role`, writing is `iam:manage-users`. That is
 * not a stylistic echo. What this route creates *is* an account in the identity
 * provider, and `auth/users` is where this installation already decided that
 * minting and deleting accounts is a heavier act than deciding what an existing
 * one may reach.
 *
 * One consequence is worth naming because it is a property and not a side
 * effect: **no agent scope carries `iam:manage-users`** (the sentinel in
 * `route-permission-sentinel.spec.ts` lists it among the permissions no scope
 * names), so an agent credential can never mint or revoke an agent identity.
 * Agents do not spawn agents; a person does.
 *
 * The other half of the ceiling is applied here rather than inside the service,
 * because the service takes a resolved access instead of resolving one:
 * `beyondPermissions` asks the policy engine what the caller may confer, and
 * `provision` refuses anything above the caller's own credential. Both refuse
 * the request whole. An identity that came back quietly narrower than asked for
 * is one nobody can reason about — the same rule the API-key path applies, and
 * for the same reason.
 */
@ApiTags('auth')
@ApiBearerAuth()
@Controller('auth/agent-identities')
@UseGuards(JwtAuthGuard)
@RequireSection('access')
export class AgentIdentitiesController {
  constructor(private readonly agents: AgentIdentityService) {}

  @Post()
  @RequirePermission(IAM_PERMISSION.IAM_MANAGE_USERS)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Mint an agent identity in the identity provider',
    description:
      'Creates a machine account carrying exactly the scopes asked for, and ' +
      'returns its client credentials once. Asking again for the same name ' +
      'rotates the secret rather than repeating it — the provider cannot read ' +
      'the old one back either. The identity carries a ceiling and never a ' +
      'rung: what it may reach still comes from the grants held by whoever it ' +
      'acts for.',
  })
  @ApiResponse({ status: 201, type: AgentIdentityResultDto })
  @ApiResponse({ status: 403, description: 'A scope above the caller' })
  @ApiResponse({ status: 501, description: 'Not supported in this auth mode' })
  async create(
    @Request() req: { user: AuthenticatedUser },
    @Body() dto: CreateAgentIdentityDto,
  ): Promise<AgentIdentityResultDto> {
    if (process.env.AUTH_MODE !== 'oidc') {
      throw new HttpException(
        'Agent identities live in the bundled identity provider, which this ' +
          'installation does not run. Issue an API key instead.',
        HttpStatus.NOT_IMPLEMENTED,
      );
    }
    const issuer = principalFromUser(req.user);
    const requested = this.requestedScopes(dto);
    const beyond = await this.agents.beyondPermissions(issuer, requested);
    if (beyond.length) {
      throw new ForbiddenException(
        `You cannot grant what you do not hold: ${beyond.join(', ')}`,
      );
    }
    const minted = await this.agents.provision(issuer, dto.name, requested);
    return { ...minted, groups: groupsForScopes(minted.scopes) };
  }

  @Get()
  @RequirePermission(IAM_PERMISSION.IAM_ASSIGN_ROLE)
  @ApiOperation({
    summary: 'Every agent identity Flui minted on this instance',
    description:
      'Read off the provider by the prefix Flui mints under, so an account ' +
      'somebody created there by hand is not reported as one of ours. Empty ' +
      'when there is no provider to ask.',
  })
  @ApiOkResponse({ type: [AgentIdentityDto] })
  async list(): Promise<AgentIdentityDto[]> {
    const users = await this.agents.list();
    return users.map((u) => ({
      userId: u.id,
      userName: u.userName,
      name: u.name,
    }));
  }

  /**
   * Central revocation, which is the reason this lives in the provider at all:
   * one call and the credential stops working everywhere, without Flui having
   * to be reachable to say so.
   */
  @Delete(':name')
  @RequirePermission(IAM_PERMISSION.IAM_MANAGE_USERS)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke an agent identity' })
  @ApiParam({
    name: 'name',
    description: 'The name it was minted under, not the provider username.',
  })
  @ApiOkResponse({ description: '{ revoked: boolean }' })
  async revoke(@Param('name') name: string): Promise<{ revoked: boolean }> {
    return { revoked: await this.agents.revoke(name) };
  }

  /**
   * Groups and scopes, unioned — refused rather than trimmed at every step.
   *
   * There is deliberately no unscoped form. An API key may carry its issuer's
   * full weight because a person is standing behind it in the same session; an
   * identity of its own outlives the conversation that made it, and "everything
   * its maker could do, forever" is not a sentence anybody could later read off
   * the account and understand.
   */
  private requestedScopes(dto: CreateAgentIdentityDto): string[] {
    const unknownGroups = (dto.groups ?? []).filter(
      (g) => !isPermissionGroup(g),
    );
    if (unknownGroups.length) {
      throw new BadRequestException(
        `Unknown group(s): ${unknownGroups.join(', ')}`,
      );
    }
    const { scopes: fromGroups } = expandPermissionGroups(dto.groups ?? []);
    const union = [...new Set([...(dto.scopes ?? []), ...fromGroups])];
    if (!union.length) {
      throw new BadRequestException(
        'Say what this identity may do: name `groups` or `scopes`. There is no ' +
          'unscoped agent identity.',
      );
    }
    const unknown = union.filter((s) => !isGrantableScope(s));
    if (unknown.length) {
      throw new BadRequestException(`Unknown scope(s): ${unknown.join(', ')}`);
    }
    return orderScopes(union);
  }
}
