import {
  Controller,
  Get,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Req,
  Query,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiTags,
  ApiOperation,
  ApiQuery,
  ApiResponse,
} from '@nestjs/swagger';
import { Request } from 'express';
import { GitHubOAuthService } from '../services/github-oauth.service';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import {
  GitHubOAuthStatusResponseDto,
  ConnectPatDto,
  ConnectPatResponseDto,
  PublicRepoSearchResultDto,
  PublicRepoBranchDto,
  ValidatePatDto,
  PatValidationResultDto,
} from '../dto/github-oauth.dto';

import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';

@ApiTags('GitHub OAuth')
@ApiBearerAuth()
@Controller('repositories/github')
export class GitHubOAuthController {
  constructor(private readonly githubOAuthService: GitHubOAuthService) {}

  @Post('validate-pat')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Validate a Personal Access Token without persisting it',
    description:
      'Calls GitHub /user with the supplied token and returns who it ' +
      'authenticated as, which scopes were actually granted, and which ' +
      'required scopes are missing. The token is never stored. Use this ' +
      'before POST /connect-pat to give the user immediate feedback.',
  })
  @ApiResponse({
    status: 200,
    description: 'Validation result',
    type: PatValidationResultDto,
  })
  async validatePat(
    @Body() dto: ValidatePatDto,
  ): Promise<PatValidationResultDto> {
    return this.githubOAuthService.validatePat(dto.token);
  }

  @Post('connect-pat')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Connect GitHub via Personal Access Token',
    description:
      'Only available when setup method is pat. The token is validated then stored encrypted.',
  })
  @ApiResponse({
    status: 200,
    description: 'PAT connected',
    type: ConnectPatResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Invalid token or wrong auth mode' })
  @ApiResponse({
    status: 503,
    description: 'GitHub integration not configured',
  })
  async connectPat(
    @Req() req: Request,
    @Body() dto: ConnectPatDto,
  ): Promise<ConnectPatResponseDto> {
    const { userId } = req.user as AuthenticatedUser;
    return this.githubOAuthService.connectWithPat(
      userId,
      dto.personalAccessToken,
    );
  }

  @Get('status')
  // Answers about the caller's own GitHub connection, and every built-in role
  // holds `app:read`, so nobody loses it. It is here so the credential ceiling
  // can see the route, which it does only through `@RequirePermission` and
  // `@AppAction`.
  @RequirePermission(IAM_PERMISSION.APP_READ)
  @ApiOperation({
    summary: 'Check GitHub connection status for the current user',
  })
  @ApiResponse({
    status: 200,
    description: 'Connection status',
    type: GitHubOAuthStatusResponseDto,
  })
  async getStatus(@Req() req: Request): Promise<GitHubOAuthStatusResponseDto> {
    const { userId } = req.user as AuthenticatedUser;
    return this.githubOAuthService.getStatus(userId);
  }

  @Post('disconnect')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Disconnect GitHub for the current user' })
  @ApiResponse({ status: 204, description: 'GitHub disconnected successfully' })
  @ApiResponse({
    status: 404,
    description: 'No active GitHub connection found',
  })
  async disconnect(@Req() req: Request): Promise<void> {
    const { userId } = req.user as AuthenticatedUser;
    await this.githubOAuthService.revokeAccess(userId);
  }

  @Post('test')
  @ApiOperation({ summary: 'Test GitHub connection for the current user' })
  @ApiResponse({ status: 200, description: 'Connection test result' })
  async testConnection(
    @Req() req: Request,
  ): Promise<{ success: boolean; message: string }> {
    const { userId } = req.user as AuthenticatedUser;
    return this.githubOAuthService.testConnection(userId);
  }

  @Get('search/public')
  @ApiOperation({
    summary: 'Search public GitHub repositories',
    description:
      'Proxies to GitHub search API. Uses system GITHUB_TOKEN if configured (5000 req/hr), otherwise unauthenticated (60 req/hr).',
  })
  @ApiQuery({ name: 'q', required: true, description: 'Search query' })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Max results to return (default: 10, max: 100)',
  })
  @ApiResponse({
    status: 200,
    description: 'Matching public repositories',
    type: [PublicRepoSearchResultDto],
  })
  async searchPublicRepositories(
    @Query('q') q: string,
    @Query('limit') limit = 10,
  ): Promise<PublicRepoSearchResultDto[]> {
    if (!q) {
      throw new BadRequestException('Query parameter "q" is required');
    }
    return this.githubOAuthService.searchPublicRepositories(q, Number(limit));
  }

  @Get('public/branches')
  @ApiOperation({
    summary: 'List branches of a public GitHub repository',
    description:
      'Proxies to GitHub branches API. No connected GitHub account required.',
  })
  @ApiQuery({
    name: 'repo',
    required: true,
    description: 'Repository in owner/repo format (e.g. "vercel/next.js")',
  })
  @ApiResponse({
    status: 200,
    description: 'Branch list',
    type: [PublicRepoBranchDto],
  })
  async getPublicRepoBranches(
    @Query('repo') repo: string,
  ): Promise<PublicRepoBranchDto[]> {
    if (!repo) {
      throw new BadRequestException('Query parameter "repo" is required');
    }
    return this.githubOAuthService.getPublicRepoBranches(repo);
  }
}
