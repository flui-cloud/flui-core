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
import { PrincipalAccess } from '../../iam/interfaces/iam.types';
import { CreateApiKeyDto } from '../dto/create-api-key.dto';
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
    );
    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : undefined;
    const { entity, plaintext } = await this.apiKeyService.generateApiKey(
      dto.name,
      req.user.userId,
      expiresAt,
      scopes,
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
      'do not fully hold is refused whole at issue time, never trimmed.',
  })
  @ApiResponse({ status: 200, type: [PermissionGroupDto] })
  async listPermissionGroups(
    @Request() req: { user: AuthenticatedUser },
  ): Promise<PermissionGroupDto[]> {
    const access = await this.policy.resolveAccess(this.principalOf(req.user));
    return PERMISSION_GROUPS.map((group) => ({
      key: group.key,
      area: group.area,
      depth: group.depth,
      label: group.label,
      summary: group.summary,
      scopes: [...group.scopes],
      grantable:
        this.beyondCredential(req.user.scopes, group.scopes).length === 0 &&
        this.beyondPermissions(access, group.scopes).length === 0,
    }));
  }

  private principalOf(user: AuthenticatedUser) {
    return {
      userId: user.userId,
      email: user.email,
      role: user.role,
      isAdmin: user.isAdmin ?? false,
      scopes: user.scopes,
    };
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

  private describeKey(entity: {
    id: string;
    name: string;
    revoked: boolean;
    createdAt: Date;
    expiresAt?: Date | null;
    scopes?: string[] | null;
  }): ApiKeyResponseDto {
    const scopes = entity.scopes ?? null;
    return {
      id: entity.id,
      name: entity.name,
      revoked: entity.revoked,
      createdAt: entity.createdAt,
      expiresAt: entity.expiresAt ?? null,
      scopes,
      groups: scopes ? groupsForScopes(scopes) : null,
      ungroupedScopes: scopes ? ungroupedScopes(scopes) : null,
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
   */
  private async grantableOrThrow(
    issuer: AuthenticatedUser,
    requestedScopes: string[] | undefined,
    requestedGroups: string[] | undefined,
  ): Promise<string[] | undefined> {
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
    if (!union.length) return undefined;

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
    @Request() req: { user: AuthenticatedUser },
  ): Promise<ApiKeyResponseDto[]> {
    const keys = await this.apiKeyService.listForUser(req.user.userId);
    return keys.map((k) => this.describeKey(k));
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
}
