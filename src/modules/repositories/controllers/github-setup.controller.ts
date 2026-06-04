import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
  Query,
  Param,
  Req,
  Res,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiTags,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import type { Request, Response } from 'express';
import { AdminGuard } from '../../auth/guards/admin.guard';
import { Admin } from '../../auth/decorators/admin.decorator';
import { Public } from '../../auth/decorators/public.decorator';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { GitHubIntegrationConfigService } from '../services/github-integration-config.service';
import { GithubAppManifestStateService } from '../services/github-app-manifest-state.service';
import {
  GitHubSetupAppDto,
  GitHubSetupStatusResponseDto,
  GitHubAppManifestStartDto,
  GitHubAppManifestStartResponseDto,
  GitHubSetupHealthResponseDto,
} from '../dto/github-oauth.dto';

const DEFAULT_DASHBOARD_URL = 'http://localhost:4200';
const SETUP_RETURN_PATH = '/apps/repositories/github-setup';

@ApiTags('GitHub Setup')
@Controller('repositories/github/setup')
export class GitHubSetupController {
  private readonly logger = new Logger(GitHubSetupController.name);

  constructor(
    private readonly configService: GitHubIntegrationConfigService,
    private readonly envConfig: ConfigService,
    private readonly httpService: HttpService,
    private readonly manifestState: GithubAppManifestStateService,
  ) {}

  @Get('status')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get GitHub integration setup status',
    description:
      'Returns whether GitHub has been configured and which auth method is active. Call this first to decide which setup flow to show.',
  })
  @ApiResponse({
    status: 200,
    description: 'Setup status',
    type: GitHubSetupStatusResponseDto,
  })
  async getStatus(): Promise<GitHubSetupStatusResponseDto> {
    return this.configService.getSetupStatus();
  }

  @Get('health')
  @ApiBearerAuth()
  @UseGuards(AdminGuard)
  @Admin()
  @ApiOperation({
    summary: 'Live health check of the configured GitHub integration',
    description:
      'Performs a real call to GitHub (App JWT auth or PAT mode note) to ' +
      'verify the stored credentials still work. Returns mode-specific details.',
  })
  @ApiResponse({
    status: 200,
    description: 'Health result (ok=false when something is broken)',
    type: GitHubSetupHealthResponseDto,
  })
  async health(): Promise<GitHubSetupHealthResponseDto> {
    return this.configService.health();
  }

  @Post('pat')
  @ApiBearerAuth()
  @UseGuards(AdminGuard)
  @Admin()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Enable Personal Access Token mode',
    description:
      'Switch to PAT mode. No OAuth App required — each user will connect their own GitHub PAT via POST /repositories/github/connect-pat.',
  })
  @ApiResponse({
    status: 200,
    description: 'PAT mode enabled',
    type: GitHubSetupStatusResponseDto,
  })
  async configurePat(): Promise<GitHubSetupStatusResponseDto> {
    await this.configService.configurePatMode();
    return this.configService.getSetupStatus();
  }

  @Post('github-app')
  @ApiBearerAuth()
  @UseGuards(AdminGuard)
  @Admin()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Configure GitHub App (manual)',
    description:
      'Store GitHub App credentials manually. Prefer the manifest flow ' +
      '(POST /github-app/manifest-start) which generates the App on GitHub and ' +
      'auto-fills these fields. Use this endpoint only when you already have ' +
      'an existing GitHub App you want to connect.',
  })
  @ApiResponse({
    status: 200,
    description: 'GitHub App configured',
    type: GitHubSetupStatusResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Invalid credentials' })
  async configureGitHubApp(
    @Body() dto: GitHubSetupAppDto,
  ): Promise<GitHubSetupStatusResponseDto> {
    await this.configService.configureGitHubApp(dto);
    return this.configService.getSetupStatus();
  }

  @Post('github-app/manifest-start')
  @ApiBearerAuth()
  @UseGuards(AdminGuard)
  @Admin()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Start GitHub App creation via manifest flow',
    description:
      'Returns a GitHub App manifest payload + the GitHub URL where the admin ' +
      'should POST it. The dashboard/CLI builds a hidden HTML form and submits ' +
      'it to githubUrl with the manifest as a hidden field — GitHub then ' +
      'pre-fills its New-App form with all permissions, events, webhook and ' +
      'callback URLs. After the admin confirms, GitHub redirects back to our ' +
      'manifest-callback endpoint with a temporary code; we exchange it server-' +
      'side for App credentials and persist them automatically.',
  })
  @ApiResponse({
    status: 200,
    description: 'Manifest + redirect URL ready',
    type: GitHubAppManifestStartResponseDto,
  })
  async manifestStart(
    @Req() req: Request,
    @Body() dto: GitHubAppManifestStartDto,
  ): Promise<GitHubAppManifestStartResponseDto> {
    const user = req.user as AuthenticatedUser | undefined;
    if (!user?.userId) {
      throw new BadRequestException('Authenticated user has no userId');
    }

    const publicApiUrl = this.normalizePublicApiUrl(
      dto.publicApiUrl ?? this.resolvePublicApiUrl(req),
    );

    const callbackUrl = `${publicApiUrl}/api/v1/repositories/github-app/user-callback`;
    const webhookUrl = dto.webhooksEnabled
      ? `${publicApiUrl}/api/v1/webhooks/github-app`
      : '';

    const state = this.manifestState.issue(user.userId, callbackUrl);
    const redirectUrl = `${publicApiUrl}/api/v1/repositories/github/setup/github-app/manifest-callback/${state}`;

    const manifestJson: Record<string, unknown> = {
      name: dto.name,
      url: publicApiUrl,
      redirect_url: redirectUrl,
      callback_urls: [callbackUrl],
      public: dto.publicApp ?? false,
      request_oauth_on_install: true,
      hook_attributes: { url: webhookUrl, active: dto.webhooksEnabled },
      default_permissions: {
        contents: 'write',
        metadata: 'read',
        actions: 'write',
        workflows: 'write',
        packages: 'write',
        pull_requests: 'write',
      },
      default_events: ['workflow_run', 'push', 'pull_request'],
    };

    this.logger.log(
      `manifest-start: publicApiUrl=${publicApiUrl} redirect_url=${redirectUrl}`,
    );

    return {
      manifestJson,
      githubUrl: 'https://github.com/settings/apps/new',
      state,
    };
  }

  private normalizePublicApiUrl(raw: string): string {
    const trimmed = raw.trim().replace(/\/$/, '');
    if (!/^https?:\/\//i.test(trimmed)) {
      throw new BadRequestException(
        `publicApiUrl must be an http(s) URL, got "${raw}"`,
      );
    }
    return trimmed;
  }

  private resolvePublicApiUrl(req: Request): string {
    const fromEnv = this.envConfig.get<string>('PUBLIC_API_URL');
    if (fromEnv) return fromEnv.replace(/\/$/, '');
    const proto =
      (req.headers['x-forwarded-proto'] as string | undefined) ?? req.protocol;
    const host = req.headers['x-forwarded-host'] ?? req.headers.host;
    if (!host) {
      throw new BadRequestException(
        'PUBLIC_API_URL env is not set and request has no Host header — cannot build the manifest redirect URL.',
      );
    }
    return `${proto}://${host}`;
  }

  @Get('github-app/manifest-callback/:state')
  @Public()
  @ApiOperation({
    summary:
      'GitHub App manifest conversion callback (browser redirect target)',
    description:
      'Receives the redirect from GitHub after the admin confirms the App ' +
      'creation. Validates the state (path parameter, single-use), exchanges ' +
      'the temporary code for the App credentials, persists them, and ' +
      'redirects the browser back to the dashboard with manifest=success|error.',
  })
  async manifestCallback(
    @Query('code') code: string,
    @Param('state') state: string,
    @Res() res: Response,
  ): Promise<void> {
    const dashboardUrl = (
      this.envConfig.get<string>('FRONTEND_URL') ??
      this.envConfig.get<string>('DASHBOARD_URL') ??
      DEFAULT_DASHBOARD_URL
    ).replace(/\/$/, '');
    const returnTo = `${dashboardUrl}${SETUP_RETURN_PATH}`;

    if (!code || !state) {
      res.redirect(`${returnTo}?manifest=error&reason=missing_code_or_state`);
      return;
    }

    const consumed = this.manifestState.consume(state);
    if (!consumed) {
      res.redirect(
        `${returnTo}?manifest=error&reason=invalid_or_expired_state`,
      );
      return;
    }

    try {
      const { data } = await firstValueFrom(
        this.httpService.post(
          `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
          null,
          {
            headers: {
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
            },
          },
        ),
      );

      await this.configService.configureGitHubApp({
        appId: String(data.id),
        privateKey: data.pem,
        webhookSecret: data.webhook_secret ?? '',
        appSlug: data.slug,
        clientId: data.client_id,
        clientSecret: data.client_secret,
        callbackUrl: consumed.callbackUrl,
      });

      this.logger.log(
        `GitHub App created via manifest: slug=${data.slug} appId=${data.id}`,
      );
      res.redirect(`${returnTo}?manifest=success`);
    } catch (error) {
      const reason = encodeURIComponent(
        error?.response?.data?.message ?? error?.message ?? 'conversion_failed',
      );
      this.logger.error(
        `Manifest conversion failed: ${error?.message}`,
        error?.stack,
      );
      res.redirect(`${returnTo}?manifest=error&reason=${reason}`);
    }
  }

  @Delete()
  @ApiBearerAuth()
  @UseGuards(AdminGuard)
  @Admin()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Reset GitHub integration configuration',
    description:
      'Removes the instance-wide GitHub integration config AND all per-user tokens and App installations. Users will need to reconnect after the integration is reconfigured.',
  })
  @ApiResponse({ status: 204, description: 'Config reset' })
  async resetConfig(): Promise<void> {
    await this.configService.resetConfig();
  }
}
