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
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { ApiKeyService } from '../services/api-key.service';
import {
  CURRENT_API_KEY_ID,
  RequestWithApiKey,
} from '../strategies/api-key.strategy';
import {
  SCOPE_REQUIRES_PERMISSION,
  isGrantableScope,
  orderScopes,
} from '../constants/api-key-scopes';
import {
  PERMISSION_GROUPS,
  expandPermissionGroups,
  groupsForScopes,
  isPermissionGroup,
  ungroupedScopes,
} from '../constants/api-key-groups';
import {
  POLICY_ENGINE,
  PolicyEngine,
} from '../../iam/interfaces/policy-engine.interface';
import {
  IamPrincipal,
  PrincipalAccess,
  principalFromUser,
} from '../../iam/interfaces/iam.types';
import { CreateApiKeyDto } from '../dto/create-api-key.dto';
import { UpdateApiKeyApplicationsDto } from '../dto/update-api-key-applications.dto';
import { UpdateApiKeyProjectsDto } from '../dto/update-api-key-projects.dto';
import {
  ApiKeyResponseDto,
  CreateApiKeyResultDto,
  PermissionGroupDto,
} from '../dto/api-key-response.dto';

@ApiTags('auth')
@Controller('auth')
export class ApiKeysController {
  constructor(
    private readonly apiKeyService: ApiKeyService,
    @Inject(POLICY_ENGINE) private readonly policy: PolicyEngine,
  ) {}

  @Post('api-keys')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a new API key (OIDC mode only)' })
  @ApiBody({ type: CreateApiKeyDto })
  @ApiResponse({ status: 201, type: CreateApiKeyResultDto })
  @ApiResponse({ status: 501, description: 'Not supported in this auth mode' })
  async createApiKey(
    @Request() req: { user: AuthenticatedUser },
    @Body() dto: CreateApiKeyDto,
  ): Promise<CreateApiKeyResultDto> {
    if (process.env.AUTH_MODE !== 'oidc') {
      throw new HttpException(
        'API keys are only supported in OIDC auth mode.',
        HttpStatus.NOT_IMPLEMENTED,
      );
    }
    const scopes = await this.grantableOrThrow(
      req.user,
      dto.scopes,
      dto.groups,
      dto.unscoped,
    );
    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : undefined;
    const { entity, plaintext } = await this.apiKeyService.generateApiKey(
      dto.name,
      req.user.userId,
      expiresAt,
      scopes,
      dto.applicationIds,
      dto.projectIds,
    );
    return { ...this.describeKey(entity), key: plaintext };
  }

  /**
   * The taxonomy, annotated for whoever is asking.
   *
   * A panel cannot offer a group without its name, its one sentence, and
   * whether this person may hand it on — and computing "may hand it on" in the
   * panel would be a second copy of the ceiling, which is how the two drift.
   */
  @Get('api-key-groups')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Permission groups an API key can be issued for',
    description:
      'Areas × depth. `grantable` is resolved against the caller: a group they ' +
      'do not fully hold is refused whole at issue time, never trimmed. ' +
      '`blockedScopes` names which scopes made it so.',
  })
  @ApiResponse({ status: 200, type: [PermissionGroupDto] })
  async listPermissionGroups(
    @Request() req: { user: AuthenticatedUser },
  ): Promise<PermissionGroupDto[]> {
    const access = await this.policy.resolveAccess(this.principalOf(req.user));
    return PERMISSION_GROUPS.map((group) => {
      // Both halves of the ceiling, kept apart rather than `&&`-ed away. The
      // union is what stopped the group, and it is the same set the refusal at
      // minting time names — except that a switch shown disabled never reaches
      // minting time, so this was the one reading of it nobody could get.
      const blocked = [
        ...new Set([
          ...this.beyondCredential(req.user.scopes, group.scopes),
          ...this.beyondPermissions(access, group.scopes),
        ]),
      ];
      return {
        key: group.key,
        area: group.area,
        depth: group.depth,
        label: group.label,
        summary: group.summary,
        scopes: [...group.scopes],
        grantable: blocked.length === 0,
        blockedScopes: orderScopes(blocked),
      };
    });
  }

  private principalOf(user: AuthenticatedUser): IamPrincipal {
    return principalFromUser(user);
  }

  /** Scopes the credential making the request does not itself carry. */
  private beyondCredential(
    heldByCredential: string[] | undefined,
    requested: readonly string[],
  ): string[] {
    if (!heldByCredential?.length) return [];
    return requested.filter((s) => !heldByCredential.includes(s));
  }

  /** Scopes whose governing permission the issuer does not hold. */
  private beyondPermissions(
    access: PrincipalAccess,
    requested: readonly string[],
  ): string[] {
    return requested.filter(
      (s) =>
        !this.policy.can(
          access,
          SCOPE_REQUIRES_PERMISSION[
            s as keyof typeof SCOPE_REQUIRES_PERMISSION
          ],
        ),
    );
  }

  private describeKey(
    entity: {
      id: string;
      name: string;
      revoked: boolean;
      createdAt: Date;
      expiresAt?: Date | null;
      scopes?: string[] | null;
      lastUsedAt?: Date | null;
      skillVersion?: string | null;
      applicationIds?: string[] | null;
      projectIds?: string[] | null;
    },
    currentKeyId?: string,
  ): ApiKeyResponseDto {
    const scopes = entity.scopes ?? null;
    return {
      id: entity.id,
      name: entity.name,
      revoked: entity.revoked,
      createdAt: entity.createdAt,
      expiresAt: entity.expiresAt ?? null,
      lastUsedAt: entity.lastUsedAt ?? null,
      skillVersion: entity.skillVersion ?? null,
      scopes,
      groups: scopes ? groupsForScopes(scopes) : null,
      ungroupedScopes: scopes ? ungroupedScopes(scopes) : null,
      applicationIds: entity.applicationIds ?? null,
      projectIds: entity.projectIds ?? null,
      // A freshly minted key is never the one that minted it.
      current: !!currentKeyId && entity.id === currentKeyId,
    };
  }

  /**
   * A key is never worth more than whoever asked for it.
   *
   * Two ceilings, both refusing rather than trimming: the scope must map to a
   * permission the issuer holds, and — when the issuer is itself holding a
   * scoped credential — it must already be among that credential's scopes, so
   * a limited key cannot mint an unlimited one.
   *
   * Groups are asked for here rather than checked as a unit of their own: they
   * expand to scopes and meet the same two ceilings, so a group can never open
   * a door its scopes do not. What the group adds is the refusal — it names
   * which switch was too big, and the whole request fails, so nobody walks away
   * with a credential quietly smaller than the one they consented to.
   *
   * And the widest key of all is no longer the one nobody asked for. Saying
   * nothing used to mint the issuer's full weight; now it is refused, and the
   * full weight has to be named.
   */
  private async grantableOrThrow(
    issuer: AuthenticatedUser,
    requestedScopes: string[] | undefined,
    requestedGroups: string[] | undefined,
    unscoped: boolean | undefined,
  ): Promise<string[] | undefined> {
    const named = !!requestedScopes?.length || !!requestedGroups?.length;
    if (unscoped && named) {
      throw new BadRequestException(
        'A key is either unscoped or scoped, not both: drop `unscoped` to keep ' +
          'the scopes and groups you named, or drop them to issue an unscoped key.',
      );
    }
    if (!named) {
      // The one refusal in this file that is not about a ceiling. It is about
      // consent: the widest credential on the instance must be asked for.
      if (!unscoped) {
        throw new BadRequestException(
          'Say what this key may do: name `groups` (or `scopes`) for a limited ' +
            'key, or pass `unscoped: true` for one that carries your full ' +
            'weight. An empty request used to mean the second, silently.',
        );
      }
      return undefined;
    }

    const unknownGroups = (requestedGroups ?? []).filter(
      (g) => !isPermissionGroup(g),
    );
    if (unknownGroups.length) {
      throw new BadRequestException(
        `Unknown group(s): ${unknownGroups.join(', ')}`,
      );
    }

    const { scopes: fromGroups, askedBy } = expandPermissionGroups(
      requestedGroups ?? [],
    );
    const union = [...new Set([...(requestedScopes ?? []), ...fromGroups])];
    // Belt and braces: an empty grant reaching `generateApiKey` is stored as
    // `scopes: null`, which is the unscoped key. Nothing can produce it today
    // — every group names scopes — but the failure would be silent and wide.
    if (!union.length) {
      throw new BadRequestException(
        'That request names nothing this instance can grant.',
      );
    }

    const unknown = union.filter((s) => !isGrantableScope(s));
    if (unknown.length) {
      throw new BadRequestException(`Unknown scope(s): ${unknown.join(', ')}`);
    }

    const requested = orderScopes(union);
    // Which group asked for it, when one did: a refusal naming only the scope
    // leaves a person guessing which switch to leave off.
    const blame = (scopes: string[]) =>
      scopes
        .map((s) => {
          const group = askedBy.get(s as (typeof fromGroups)[number]);
          return group ? `${s} (from group ${group})` : s;
        })
        .join(', ');

    const beyond = this.beyondCredential(issuer.scopes, requested);
    if (beyond.length) {
      throw new ForbiddenException(
        `The credential making this request does not carry: ${blame(beyond)}`,
      );
    }

    const access = await this.policy.resolveAccess(this.principalOf(issuer));
    const refused = this.beyondPermissions(access, requested);
    if (refused.length) {
      throw new ForbiddenException(
        `You cannot grant what you do not hold: ${blame(refused)}`,
      );
    }

    return requested;
  }

  @Get('api-keys')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List API keys for the authenticated user' })
  @ApiResponse({ status: 200, type: [ApiKeyResponseDto] })
  async listApiKeys(
    @Request() req: { user: AuthenticatedUser } & RequestWithApiKey,
  ): Promise<ApiKeyResponseDto[]> {
    const keys = await this.apiKeyService.listForUser(req.user.userId);
    // Which of these is the one in the caller's hand. Nothing else on this
    // instance can answer it: the row is identified by a digest, so the name is
    // all a client has, and after `/sandbox/resume` two rows share a tenancy.
    // The generic warning shown on every row is therefore false on some of them.
    const current = req[CURRENT_API_KEY_ID];
    return keys.map((k) => this.describeKey(k, current));
  }

  @Delete('api-keys/:id')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke an API key' })
  @ApiParam({ name: 'id' })
  @ApiOkResponse({ description: '{ success: true }' })
  async revokeApiKey(
    @Param('id') id: string,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<{ success: boolean }> {
    const revoked = await this.apiKeyService.revokeById(id, req.user.userId);
    if (!revoked) {
      throw new NotFoundException(`API key ${id} not found`);
    }
    return { success: true };
  }

  @Patch('api-keys/:id/applications')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Change which applications a key may act on, without reissuing it',
    description:
      "Replaces the key's application list wholesale — send the complete set " +
      'you want it to hold, not just the ones being added. Omit ' +
      '`applicationIds` (or send an empty array) to lift the restriction. The ' +
      'key itself does not change: whatever already holds it keeps working, ' +
      'now against the new list.',
  })
  @ApiParam({ name: 'id' })
  @ApiBody({ type: UpdateApiKeyApplicationsDto })
  @ApiResponse({ status: 200, type: ApiKeyResponseDto })
  async updateApiKeyApplications(
    @Param('id') id: string,
    @Body() dto: UpdateApiKeyApplicationsDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<ApiKeyResponseDto> {
    const entity = await this.apiKeyService.updateApplicationIds(
      id,
      req.user.userId,
      dto.applicationIds ?? null,
    );
    if (!entity) {
      throw new NotFoundException(`API key ${id} not found`);
    }
    return this.describeKey(entity);
  }

  @Patch('api-keys/:id/projects')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Change which projects a key may act on, without reissuing it',
    description:
      "Replaces the key's project list wholesale — send the complete set you " +
      'want it to hold, not just the ones being added. Omit `projectIds` (or ' +
      'send an empty array) to lift the restriction. Independent of the ' +
      'application list on the same key: an application counts as covered ' +
      'the moment either list reaches it, and an app added to a granted ' +
      'project later is covered on its next request — nothing to reissue.',
  })
  @ApiParam({ name: 'id' })
  @ApiBody({ type: UpdateApiKeyProjectsDto })
  @ApiResponse({ status: 200, type: ApiKeyResponseDto })
  async updateApiKeyProjects(
    @Param('id') id: string,
    @Body() dto: UpdateApiKeyProjectsDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<ApiKeyResponseDto> {
    const entity = await this.apiKeyService.updateProjectIds(
      id,
      req.user.userId,
      dto.projectIds ?? null,
    );
    if (!entity) {
      throw new NotFoundException(`API key ${id} not found`);
    }
    return this.describeKey(entity);
  }
}
