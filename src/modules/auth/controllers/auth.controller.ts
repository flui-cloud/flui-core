import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  HttpException,
  NotFoundException,
  NotImplementedException,
  Param,
  Post,
  Put,
  Request,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { AdminGuard } from '../guards/admin.guard';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { LocalAuthService } from '../services/local-auth.service';
import { RegisterDto, RegisterResponseDto } from '../dto/register.dto';
import { LoginDto, LoginResponseDto } from '../dto/login.dto';
import { RefreshTokenDto, RefreshResponseDto } from '../dto/refresh-token.dto';
import { ChangePasswordDto } from '../dto/change-password.dto';
import { UpdateMeDto, UserProfileDto } from '../dto/update-me.dto';
import { Public } from '../decorators/public.decorator';
import { Admin } from '../decorators/admin.decorator';
import {
  clearFluiSessionCookie,
  setFluiSessionCookie,
} from '../utils/session-cookie.util';
import { ConfigureAuthModeService } from '../../dns/services/configure-auth-mode.service';
import { ConfigureAuthModeDto } from '../../dns/dto/configure-auth-mode.dto';
import { ConfigureAuthModeResultDto } from '../../dns/dto/configure-auth-mode-result.dto';
import { ApiKeyService } from '../services/api-key.service';
import { CreateApiKeyDto } from '../dto/create-api-key.dto';
import {
  ApiKeyResponseDto,
  CreateApiKeyResultDto,
} from '../dto/api-key-response.dto';
import { OidcBootstrapService } from '../services/oidc-bootstrap.service';
import { OidcProfileSyncService } from '../services/oidc-profile-sync.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserEntity } from '../entities/user.entity';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly localAuthService: LocalAuthService,
    private readonly configureAuthModeService: ConfigureAuthModeService,
    private readonly apiKeyService: ApiKeyService,
    private readonly oidcBootstrapService: OidcBootstrapService,
    private readonly profileSync: OidcProfileSyncService,
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
  ) {}

  private get isLocalMode(): boolean {
    return process.env.AUTH_MODE === 'local';
  }

  @Post('register')
  @Public()
  @ApiOperation({
    summary: 'Register a new user (local auth mode only)',
    description:
      'First call is open (creates the admin). Subsequent calls require an authenticated admin.',
  })
  @ApiBody({ type: RegisterDto })
  @ApiCreatedResponse({ type: RegisterResponseDto })
  @ApiResponse({
    status: 403,
    description: 'Only admins can create new accounts',
  })
  async register(
    @Request() req: { user?: AuthenticatedUser },
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RegisterResponseDto> {
    if (!this.isLocalMode) {
      throw new NotImplementedException(
        'Registration is not available in OIDC mode',
      );
    }
    const userCount = await this.localAuthService.countUsers();
    if (userCount > 0 && !req.user?.isAdmin) {
      throw new ForbiddenException('Only admins can create new accounts');
    }
    const result = await this.localAuthService.register(dto);
    setFluiSessionCookie(res, result.access_token);
    return result;
  }

  @Post('login')
  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Login with email and password (local auth mode only)',
  })
  @ApiBody({ type: LoginDto })
  @ApiOkResponse({ type: LoginResponseDto })
  @ApiUnauthorizedResponse({ description: 'Invalid credentials' })
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponseDto> {
    if (!this.isLocalMode) {
      throw new NotImplementedException(
        'Local login is not available in OIDC mode',
      );
    }
    const result = await this.localAuthService.login(dto);
    setFluiSessionCookie(res, result.access_token);
    return result;
  }

  @Post('refresh')
  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Obtain a new access token using a refresh token (local mode only)',
  })
  @ApiBody({ type: RefreshTokenDto })
  @ApiOkResponse({ type: RefreshResponseDto })
  @ApiUnauthorizedResponse({ description: 'Invalid or expired refresh token' })
  async refresh(
    @Body() dto: RefreshTokenDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RefreshResponseDto> {
    if (!this.isLocalMode) {
      throw new NotImplementedException(
        'Token refresh is not available in OIDC mode',
      );
    }
    const result = await this.localAuthService.refresh(dto.refresh_token);
    setFluiSessionCookie(res, result.access_token);
    return result;
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke refresh token (local mode only)' })
  @ApiBody({ type: RefreshTokenDto })
  @ApiOkResponse({ description: '{ success: true }' })
  async logout(
    @Body() dto: RefreshTokenDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ success: boolean }> {
    if (!this.isLocalMode) {
      throw new NotImplementedException('Logout is not available in OIDC mode');
    }
    await this.localAuthService.logout(dto.refresh_token);
    clearFluiSessionCookie(res);
    return { success: true };
  }

  @Post('oidc-logout')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Clear flui_session cookie for OIDC logout (OIDC mode only)',
    description:
      'Called by the frontend before redirecting to the Zitadel end_session endpoint. ' +
      'Clears the httpOnly flui_session cookie so ForwardAuth stops accepting the old token.',
  })
  @ApiOkResponse({ description: '{ success: true }' })
  oidcLogout(@Res({ passthrough: true }) res: Response): { success: boolean } {
    clearFluiSessionCookie(res);
    return { success: true };
  }

  @Post('change-password')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Change password for the authenticated user (local mode only)',
  })
  @ApiBody({ type: ChangePasswordDto })
  @ApiOkResponse({
    description: 'Password changed. All refresh tokens revoked.',
  })
  @ApiUnauthorizedResponse({ description: 'Current password incorrect' })
  async changePassword(
    @Request() req: { user: AuthenticatedUser },
    @Body() dto: ChangePasswordDto,
  ): Promise<{ success: boolean }> {
    if (!this.isLocalMode) {
      throw new NotImplementedException(
        'Password change is not available in OIDC mode',
      );
    }
    await this.localAuthService.changePassword(req.user.userId, dto);
    return { success: true };
  }

  @Put('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Update profile for the authenticated user (local mode only)',
  })
  @ApiBody({ type: UpdateMeDto })
  @ApiOkResponse({ type: UserProfileDto })
  async updateMe(
    @Request() req: { user: AuthenticatedUser },
    @Body() dto: UpdateMeDto,
  ): Promise<UserProfileDto> {
    if (!this.isLocalMode) {
      throw new NotImplementedException(
        'Profile update is not available in OIDC mode',
      );
    }
    const user = await this.localAuthService.updateMe(req.user.userId, dto);
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      isAdmin: user.isAdmin,
    };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get authenticated user info from JWT token' })
  @ApiOkResponse({ description: 'Returns the authenticated user' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid Bearer token' })
  me(@Request() req: { user: AuthenticatedUser }): AuthenticatedUser {
    return req.user;
  }

  @Post('me/refresh')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Force a profile re-sync from the OIDC provider, bypassing the cache TTL',
  })
  @ApiOkResponse({ description: 'Returns the refreshed authenticated user' })
  async refreshMe(
    @Request() req: { user: AuthenticatedUser },
  ): Promise<AuthenticatedUser> {
    const user = await this.userRepo.findOneByOrFail({ id: req.user.userId });
    const synced = await this.profileSync.syncFromProvider(user, {
      force: true,
    });
    return {
      userId: synced.id,
      email: synced.email,
      name: synced.displayName ?? synced.name ?? null,
      firstName: synced.firstName,
      lastName: synced.lastName,
      displayName: synced.displayName,
      roles: req.user.roles,
      role: synced.role,
      isAdmin: synced.isAdmin,
    };
  }

  @Post('oidc-session')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Exchange a Zitadel access token for a flui_session cookie (OIDC mode only)',
    description:
      'The frontend calls this after OIDC code exchange. ' +
      'The Bearer token is validated by the JWKS strategy and mirrored into ' +
      'the httpOnly flui_session cookie so the browser can reach internal apps via ForwardAuth.',
  })
  @ApiOkResponse({ description: 'Cookie set. Returns authenticated user.' })
  @ApiUnauthorizedResponse({ description: 'Invalid or expired Zitadel token' })
  oidcSession(
    @Request()
    req: { user: AuthenticatedUser; headers: { authorization?: string } },
    @Res({ passthrough: true }) res: Response,
  ): AuthenticatedUser {
    if (!this.isLocalMode) {
      const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '');
      if (bearer) setFluiSessionCookie(res, bearer);
    }
    return req.user;
  }

  @Get('config')
  @Public()
  @ApiOperation({
    summary:
      'Get public auth configuration (auth mode, OIDC issuer, web + CLI client IDs)',
  })
  @ApiOkResponse({
    description: '{ authMode, issuer?, clientId?, cliClientId? }',
  })
  getConfig(): Promise<{
    authMode: string;
    issuer?: string;
    clientId?: string;
    cliClientId?: string;
  }> {
    return this.oidcBootstrapService.getPublicOidcConfig();
  }

  @Post('bootstrap')
  @UseGuards(JwtAuthGuard, AdminGuard)
  @Admin()
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Run full OIDC bootstrap for the control cluster (idempotent)',
    description:
      'Creates the Flui project, roles, web + CLI OIDC apps, bootstrap admin, patches ConfigMap and triggers rolling restart. ' +
      'Called automatically by the CLI after Zitadel becomes ready during `flui env create`. Safe to re-run on existing installs.',
  })
  @ApiOkResponse({ description: 'OidcBootstrapResult' })
  async bootstrapOidc() {
    return this.oidcBootstrapService.bootstrap();
  }

  @Post('provision-cli-app')
  @UseGuards(JwtAuthGuard, AdminGuard)
  @Admin()
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Provision the Flui CLI native OIDC app in Zitadel (idempotent)',
    description:
      'Creates the "Flui CLI" native OIDC app if it does not exist and stores OIDC_CLI_CLIENT_ID in flui-api-config. Run this once on existing installs that pre-date the CLI login feature.',
  })
  @ApiOkResponse({ description: '{ cliClientId: string }' })
  async provisionCliApp(): Promise<{ cliClientId: string }> {
    const result = await this.oidcBootstrapService.provisionCliApp();
    return { cliClientId: result.clientId };
  }

  @Post('provision-mcp-app')
  @UseGuards(JwtAuthGuard, AdminGuard)
  @Admin()
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Provision the Flui MCP native OIDC app + mcp:* roles (idempotent)',
    description:
      'Creates the "Flui MCP" native OIDC app and the mcp:* scope roles if missing, and stores OIDC_MCP_CLIENT_ID in flui-api-config. Run once on existing installs to enable the MCP agent surface.',
  })
  @ApiOkResponse({ description: '{ mcpClientId: string }' })
  async provisionMcpApp(): Promise<{ mcpClientId: string }> {
    return this.oidcBootstrapService.provisionMcpApp();
  }

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
    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : undefined;
    const { entity, plaintext } = await this.apiKeyService.generateApiKey(
      dto.name,
      req.user.userId,
      expiresAt,
    );
    return {
      id: entity.id,
      name: entity.name,
      revoked: entity.revoked,
      createdAt: entity.createdAt,
      expiresAt: entity.expiresAt ?? null,
      key: plaintext,
    };
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
    return keys.map((k) => ({
      id: k.id,
      name: k.name,
      revoked: k.revoked,
      createdAt: k.createdAt,
      expiresAt: k.expiresAt ?? null,
    }));
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

  @Post('configure-mode')
  @UseGuards(JwtAuthGuard, AdminGuard)
  @Admin()
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Switch platform auth mode (local ↔ oidc)',
    description:
      'Patches flui-secrets, flui-api-config, and flui-web-config on the control cluster ' +
      'with the new auth configuration, then restarts flui-api and flui-web. ' +
      'Requires admin. In local mode: first call allowed without auth if no users exist yet.',
  })
  @ApiBody({ type: ConfigureAuthModeDto })
  @ApiOkResponse({ type: ConfigureAuthModeResultDto })
  @ApiResponse({
    status: 400,
    description: 'Missing required fields for the selected auth mode',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Admin access required' })
  @ApiResponse({ status: 404, description: 'Control cluster not found' })
  async configureMode(
    @Body() dto: ConfigureAuthModeDto,
  ): Promise<ConfigureAuthModeResultDto> {
    return this.configureAuthModeService.configureAuthMode(dto);
  }
}
