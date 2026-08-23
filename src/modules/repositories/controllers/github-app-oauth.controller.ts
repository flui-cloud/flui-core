import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { GitHubAppService } from '../services/github-app.service';
import {
  GhcrPatStatusDto,
  SaveGhcrPatDto,
  UpdateGhcrPatExpiryDto,
} from '../dto/ghcr-pat.dto';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { Public } from '../../auth/decorators/public.decorator';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { GithubAppInstallStateService } from '../services/github-app-install-state.service';
import { GithubAppUserAuthService } from '../services/github-app-user-auth.service';
import { UserEventsGateway } from '../../auth/gateway/user-events.gateway';
import { ConfigService } from '@nestjs/config';

const DEFAULT_DASHBOARD_URL = 'http://localhost:4200';
const DEFAULT_POST_INSTALL_PATH = '/github/installed';

@ApiTags('github-app-oauth')
@Controller('repositories/github-app')
export class GithubAppOAuthController {
  constructor(
    private readonly stateStore: GithubAppInstallStateService,
    private readonly userAuth: GithubAppUserAuthService,
    private readonly userEvents: UserEventsGateway,
    private readonly configService: ConfigService,
    private readonly githubAppService: GitHubAppService,
  ) {}

  // The instance's GitHub App installations — same credential, same right as
  // the setup routes next door.
  @Get('installations')
  @ApiBearerAuth()
  @RequirePermission(IAM_PERMISSION.INTEGRATION_MANAGE)
  @ApiOperation({
    summary: 'List all tracked GitHub App installations (admin only)',
    description:
      'Returns every installation row in the database, regardless of which ' +
      'Flui user originally installed the app. Use this to find the ' +
      '`installationId` of a wrongly-tracked installation before removing it.',
  })
  async listInstallations() {
    return this.githubAppService.listInstallations();
  }

  @Delete('installations/:installationId')
  @ApiBearerAuth()
  @RequirePermission(IAM_PERMISSION.INTEGRATION_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove a tracked GitHub App installation from the database',
    description:
      'Deletes the installation row from Flui only. Does NOT uninstall the ' +
      'app on GitHub — if the app is still installed on the account, the ' +
      'next webhook will re-create the record. Use this to clean up a ' +
      'wrongly-recorded installation after the app has already been ' +
      'uninstalled on GitHub.',
  })
  async deleteInstallation(
    @Param('installationId', ParseIntPipe) installationId: number,
  ): Promise<void> {
    const removed =
      await this.githubAppService.deleteInstallation(installationId);
    if (!removed) {
      throw new NotFoundException(
        `Installation ${installationId} not found in the database`,
      );
    }
  }

  @Post('rescan-installations')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Re-sync the current user installations from GitHub',
    description:
      'Calls GitHub with the user OAuth token and upserts every accessible ' +
      'GitHub App installation into the local database. Use this after ' +
      'installing the App on a new account/org outside the Flui dashboard, ' +
      'or in webhook-less environments where the `installation` event ' +
      "doesn't reach Flui.",
  })
  async rescanInstallations(
    @Req() req: Request,
  ): Promise<{ count: number; installationIds: number[] }> {
    const user = req.user as AuthenticatedUser | undefined;
    if (!user?.userId) {
      throw new BadRequestException('Authenticated user has no userId');
    }
    return this.userAuth.rescanInstallations(user.userId);
  }

  @Get('install-url')
  @ApiBearerAuth()
  // Answers about the caller's own GitHub connection, and every built-in role
  // holds `app:read`, so nobody loses it. It is here so the credential ceiling
  // can see the route, which it does only through `@RequirePermission` and
  // `@AppAction`.
  @RequirePermission(IAM_PERMISSION.APP_READ)
  @ApiOperation({
    summary: 'Generate a GitHub App connect URL for the current user',
    description:
      'Returns an OAuth authorize URL (always fires the post-auth callback ' +
      'regardless of whether the App is already installed on the user account). ' +
      'If the user is already connected with a valid token, returns ' +
      '`{ alreadyConnected: true, login }` and no URL — caller should skip the ' +
      'browser flow. Pass `cliCallback=http://127.0.0.1:<port>/callback` to ' +
      'redirect to a CLI-side loopback server instead of the dashboard after ' +
      'GitHub completes authorization.',
  })
  async getInstallUrl(
    @Req() req: Request,
    @Query('cliCallback') cliCallback?: string,
  ): Promise<{
    alreadyConnected: boolean;
    login?: string;
    needsInstall?: boolean;
    installUrl?: string;
    state?: string;
  }> {
    const user = req.user as AuthenticatedUser | undefined;
    if (!user?.userId) {
      throw new BadRequestException('Authenticated user has no userId');
    }

    const status = await this.userAuth.getConnectionStatus(user.userId);
    const installationsCount = status.installationsCount ?? 0;
    if (status.connected && installationsCount > 0) {
      return { alreadyConnected: true, login: status.login };
    }

    const validatedCliCallback = cliCallback
      ? this.assertLocalLoopbackUrl(cliCallback)
      : undefined;
    const state = this.stateStore.issue(user.userId, validatedCliCallback);
    // Token but no installation → skip the OAuth re-prompt and send the user
    // straight to GitHub's install picker (it still fires OAuth on install).
    const installUrl = status.connected
      ? await this.userAuth.buildInstallOnlyUrl(state)
      : await this.userAuth.buildInstallUrl(state);
    return {
      alreadyConnected: false,
      needsInstall: status.connected,
      login: status.login,
      installUrl,
      state,
    };
  }

  private assertLocalLoopbackUrl(raw: string): string {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new BadRequestException(`cliCallback is not a valid URL: ${raw}`);
    }
    const isLoopback =
      url.protocol === 'http:' &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
    if (!isLoopback) {
      throw new BadRequestException(
        'cliCallback must be http://127.0.0.1:<port>/<path> (loopback only)',
      );
    }
    return url.toString();
  }

  @Get('user-callback')
  @Public()
  @ApiOperation({
    summary: 'Callback target for GitHub App install + OAuth authorization',
    description:
      'Public endpoint: authentication is carried by the `state` query param, ' +
      'which was issued by /install-url for the authenticated Flui user. ' +
      'On success, saves the user-to-server token, emits a WebSocket event to ' +
      'the user, and redirects to the dashboard.',
  })
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('installation_id') installationId: string | undefined,
    @Query('setup_action') setupAction: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const explicit = this.configService.get<string>(
      'GITHUB_APP_POST_INSTALL_REDIRECT',
    );
    const fallbackRedirect =
      explicit ??
      `${(
        this.configService.get<string>('FRONTEND_URL') ??
        this.configService.get<string>('DASHBOARD_URL') ??
        DEFAULT_DASHBOARD_URL
      ).replace(/\/$/, '')}${DEFAULT_POST_INSTALL_PATH}`;

    if (!state) {
      res.redirect(`${fallbackRedirect}?error=missing_state`);
      return;
    }
    const consumed = this.stateStore.consume(state);
    if (!consumed) {
      res.redirect(`${fallbackRedirect}?error=expired_state`);
      return;
    }
    const { fluiUserId, cliCallbackUrl } = consumed;
    const redirectTarget = cliCallbackUrl ?? fallbackRedirect;

    if (!code) {
      res.redirect(
        `${redirectTarget}?error=no_code&setup_action=${setupAction ?? 'install'}`,
      );
      return;
    }

    try {
      const tokens = await this.userAuth.exchangeCode(code);
      const stored = await this.userAuth.saveToken(
        fluiUserId,
        tokens,
        installationId ?? null,
      );
      this.userEvents.emitGithubConnected(fluiUserId, {
        githubLogin: stored.githubLogin,
        installationId: stored.installationId,
      });
      res.redirect(
        `${redirectTarget}?status=connected&login=${encodeURIComponent(stored.githubLogin)}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.redirect(
        `${redirectTarget}?error=exchange_failed&msg=${encodeURIComponent(msg)}`,
      );
    }
  }

  @Get('packages-pat/status')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Whether the current user has a GHCR packages PAT configured',
  })
  async getPatStatus(@Req() req: Request): Promise<GhcrPatStatusDto> {
    const user = req.user as AuthenticatedUser | undefined;
    if (!user?.userId) {
      throw new BadRequestException('Authenticated user has no userId');
    }
    return this.userAuth.getGhcrPatStatus(user.userId);
  }

  @Post('packages-pat')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Save a classic GitHub PAT with read:packages for GHCR pulls',
    description:
      'Required because GitHub App installation and user-to-server tokens ' +
      'cannot currently read container packages outside of GitHub Actions. ' +
      'See https://github.com/orgs/community/discussions/34084.',
  })
  async savePat(
    @Req() req: Request,
    @Body() body: SaveGhcrPatDto,
  ): Promise<GhcrPatStatusDto> {
    const user = req.user as AuthenticatedUser | undefined;
    if (!user?.userId) {
      throw new BadRequestException('Authenticated user has no userId');
    }
    return this.userAuth.saveGhcrPat(
      user.userId,
      body.token.trim(),
      new Date(body.expiresAt),
    );
  }

  @Put('packages-pat/rotate')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Rotate the GHCR PAT (replace token + expiry)',
    description:
      'Same payload as POST. Returns 404 if no PAT is currently configured.',
  })
  async rotatePat(
    @Req() req: Request,
    @Body() body: SaveGhcrPatDto,
  ): Promise<GhcrPatStatusDto> {
    const user = req.user as AuthenticatedUser | undefined;
    if (!user?.userId) {
      throw new BadRequestException('Authenticated user has no userId');
    }
    return this.userAuth.rotateGhcrPat(
      user.userId,
      body.token.trim(),
      new Date(body.expiresAt),
    );
  }

  @Patch('packages-pat/expiry')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Update the GHCR PAT expiry without re-entering the token',
  })
  async updatePatExpiry(
    @Req() req: Request,
    @Body() body: UpdateGhcrPatExpiryDto,
  ): Promise<GhcrPatStatusDto> {
    const user = req.user as AuthenticatedUser | undefined;
    if (!user?.userId) {
      throw new BadRequestException('Authenticated user has no userId');
    }
    return this.userAuth.updateGhcrPatExpiry(
      user.userId,
      new Date(body.expiresAt),
    );
  }

  @Delete('packages-pat')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Revoke the GHCR packages PAT for the current user',
  })
  async deletePat(@Req() req: Request): Promise<{ ok: true }> {
    const user = req.user as AuthenticatedUser | undefined;
    if (!user?.userId) {
      throw new BadRequestException('Authenticated user has no userId');
    }
    await this.userAuth.deleteGhcrPat(user.userId);
    return { ok: true };
  }
}
