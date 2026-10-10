import {
  IsString,
  IsArray,
  IsOptional,
  IsBoolean,
  MinLength,
  IsNotEmpty,
} from 'class-validator';
import { GitHubAuthMethod } from '../enums/github-auth-method.enum';
import { ApiProperty } from '@nestjs/swagger';

export class GitHubOAuthStatusResponseDto {
  @ApiProperty({ description: 'Whether GitHub OAuth is connected' })
  connected: boolean;

  @ApiProperty({ description: 'GitHub username', required: false })
  githubUsername?: string;

  @ApiProperty({ description: 'OAuth scopes granted', required: false })
  scopes?: string;

  @ApiProperty({
    description: 'When the connection was created',
    required: false,
  })
  connectedAt?: Date;
}

export class AvailableRepositoryDto {
  @ApiProperty({ description: 'GitHub repository ID' })
  id: string;

  @ApiProperty({ description: 'Repository name' })
  name: string;

  @ApiProperty({ description: 'Full repository name (owner/repo)' })
  fullName: string;

  @ApiProperty({ description: 'Repository owner' })
  owner: string;

  @ApiProperty({ description: 'Repository description' })
  description: string;

  @ApiProperty({ description: 'Default branch name' })
  defaultBranch: string;

  @ApiProperty({ description: 'Whether repository is private' })
  private: boolean;

  @ApiProperty({ description: 'Repository clone URL' })
  cloneUrl: string;

  @ApiProperty({ description: 'Repository HTML URL' })
  htmlUrl: string;

  @ApiProperty({ description: 'Primary language' })
  language: string;

  @ApiProperty({ description: 'Last update timestamp' })
  updatedAt: Date;

  @ApiProperty({ description: 'Whether this repository is already imported' })
  isImported: boolean;
}

export class ImportRepositoriesDto {
  @IsArray()
  @IsString({ each: true })
  @ApiProperty({
    description: 'Array of GitHub repository full names (owner/repo) to import',
    example: ['vercel/next.js', 'facebook/react'],
    type: [String],
  })
  repositoryIds: string[];

  @IsOptional()
  @IsBoolean()
  @ApiProperty({
    description: 'Enable auto-deploy on push for imported repositories',
    required: false,
    default: false,
  })
  autoDeployEnabled?: boolean;
}

export class ConnectPatDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @ApiProperty({
    description: 'GitHub Personal Access Token (ghp_xxx or github_pat_xxx)',
    example: 'ghp_xxxxxxxxxxxxxxxxxxxx',
  })
  personalAccessToken: string;
}

export class GitHubSetupAppDto {
  @IsString()
  @IsNotEmpty()
  @ApiProperty({
    description: 'GitHub App ID (numeric string)',
    example: '123456',
  })
  appId: string;

  @IsString()
  @IsNotEmpty()
  @ApiProperty({ description: 'GitHub App Private Key (PEM format)' })
  privateKey: string;

  @IsString()
  @IsNotEmpty()
  @ApiProperty({
    description: 'Webhook secret configured in the GitHub App settings',
  })
  webhookSecret: string;

  @IsString()
  @IsNotEmpty()
  @ApiProperty({
    description: 'GitHub App slug (from the app URL)',
    example: 'flui-cloud',
  })
  appSlug: string;

  @IsString()
  @IsOptional()
  @ApiProperty({
    required: false,
    description:
      'OAuth Client ID of the GitHub App. Required if "Request user authorization (OAuth) during installation" is enabled, so users can connect their own GitHub identity.',
  })
  clientId?: string;

  @IsString()
  @IsOptional()
  @ApiProperty({
    required: false,
    description: 'OAuth Client Secret paired with clientId.',
  })
  clientSecret?: string;

  @IsString()
  @IsOptional()
  @ApiProperty({
    required: false,
    description:
      'OAuth callback URL (must match the "Callback URL" set on the GitHub App). Required to start the user-authorization flow.',
    example: 'https://myflui.com/api/v1/repositories/github-app/user-callback',
  })
  callbackUrl?: string;
}

export class GitHubSetupStatusResponseDto {
  @ApiProperty({
    description: 'Whether GitHub integration has been configured',
  })
  configured: boolean;

  @ApiProperty({
    description: 'Selected auth method',
    enum: GitHubAuthMethod,
    nullable: true,
  })
  authMethod: GitHubAuthMethod | null;

  @ApiProperty({
    description:
      'GitHub App slug — use to build the install URL: https://github.com/apps/{appSlug}/installations/new',
    required: false,
    example: 'flui-cloud',
  })
  appSlug?: string;

  @ApiProperty({
    description:
      'Where builds push their images: "ghcr" (each owner\'s GitHub Container Registry, which needs a GitHub token to pull) or "flui" (the registry this instance runs, which needs no GitHub token for images).',
    enum: ['ghcr', 'flui'],
  })
  imageRegistry: 'ghcr' | 'flui';
}

export class ConnectPatResponseDto {
  @ApiProperty()
  connected: boolean;

  @ApiProperty()
  githubUsername: string;
}

export class ImportedRepositoryRefDto {
  @ApiProperty({
    description:
      'Flui Repository UUID — use this as sourceConfig.repositoryId on POST /applications',
  })
  id: string;

  @ApiProperty({
    description: 'GitHub owner/repo full name',
    example: 'dawit-io/nextjs-app',
  })
  fullName: string;

  @ApiProperty({
    description:
      'Whether this repository was newly imported by this call or already existed',
    enum: ['imported', 'already_imported'],
    example: 'imported',
  })
  status: 'imported' | 'already_imported';
}

export class ImportRepositoriesResponseDto {
  @ApiProperty({
    description: 'Number of repositories newly created by this call',
  })
  imported: number;

  @ApiProperty({
    description:
      'Number of repositories skipped because they were already imported (not an error — their UUIDs are still returned in `repositories`)',
  })
  skipped: number;

  @ApiProperty({ description: 'Number of repositories that failed to import' })
  failed: number;

  @ApiProperty({
    type: [ImportedRepositoryRefDto],
    description:
      'All repositories that are now available after this call — both newly imported and already-existing ones. ' +
      'Use the `id` field as `sourceConfig.repositoryId` for POST /applications.',
  })
  repositories: ImportedRepositoryRefDto[];

  @ApiProperty({
    description:
      'Array of Flui Repository UUIDs (newly imported + already imported). Same as `repositories[].id`.',
    type: [String],
  })
  importedRepositoryIds: string[];

  @ApiProperty({
    description: 'Array of error messages for failed imports',
    required: false,
  })
  errors?: string[];
}

export class PublicRepoSearchResultDto {
  @ApiProperty({ description: 'Repository name' })
  name: string;

  @ApiProperty({ description: 'Full repository name (owner/repo)' })
  full_name: string;

  @ApiProperty({ description: 'Repository description', nullable: true })
  description: string | null;

  @ApiProperty({ description: 'Number of stars' })
  stars: number;

  @ApiProperty({ description: 'Primary language', nullable: true })
  language: string | null;

  @ApiProperty({ description: 'Default branch name' })
  default_branch: string;

  @ApiProperty({ description: 'HTTPS clone URL' })
  clone_url: string;

  @ApiProperty({ description: 'Repository HTML URL' })
  html_url: string;

  @ApiProperty({ description: 'Always false for public repos', default: false })
  is_private: false;
}

export class PublicRepoBranchDto {
  @ApiProperty({ description: 'Branch name' })
  name: string;

  @ApiProperty({ description: 'HEAD commit SHA' })
  sha: string;
}

export class GitHubAppManifestStartDto {
  @IsString()
  @IsNotEmpty()
  @ApiProperty({
    description:
      'Display name for the GitHub App to be created. Must be unique across GitHub.',
    example: 'flui-acme',
  })
  name: string;

  @IsBoolean()
  @ApiProperty({
    description: 'Whether webhooks should be enabled on the new App',
  })
  webhooksEnabled: boolean;

  @IsBoolean()
  @IsOptional()
  @ApiProperty({
    required: false,
    default: false,
    description:
      'When true, the App is created as public on GitHub — any account or org can install it. When false (default), only the account that owns the App can install it. Enable this if Flui needs to access repos under multiple accounts or organizations.',
  })
  publicApp?: boolean;

  @IsString()
  @IsOptional()
  @ApiProperty({
    required: false,
    description:
      'Public base URL of this Flui API instance. Used to derive the manifest redirect URL, the OAuth callback URL and (when webhooks are enabled) the webhook URL. ' +
      'If omitted, the API falls back to the PUBLIC_API_URL env var and finally to the request Host header.',
    example: 'https://flui.acme.com',
  })
  publicApiUrl?: string;
}

export class GitHubAppManifestStartResponseDto {
  @ApiProperty({
    description:
      'The manifest payload to POST to githubUrl as a hidden form field named "manifest".',
    type: Object,
  })
  manifestJson: Record<string, unknown>;

  @ApiProperty({
    description:
      'URL to POST the manifest to. Construct an HTML <form method="POST" action="<this>"> with a hidden <input name="manifest" value="<JSON.stringify(manifestJson)>"> and submit it from the browser.',
    example: 'https://github.com/settings/apps/new',
  })
  githubUrl: string;

  @ApiProperty({
    description:
      'Short-lived state token (10min TTL, single-use). Returned by GitHub in the callback redirect to correlate the conversion.',
  })
  state: string;
}

export class ValidatePatDto {
  @IsString()
  @IsNotEmpty()
  @ApiProperty({
    description: 'GitHub Personal Access Token to validate (not persisted).',
  })
  token: string;
}

export class PatValidationResultDto {
  @ApiProperty({ description: 'Whether the token is usable.' })
  valid: boolean;

  @ApiProperty({
    description: 'Authenticated GitHub login (if valid).',
    required: false,
  })
  login?: string;

  @ApiProperty({
    description: 'GitHub user ID (if valid).',
    required: false,
  })
  githubUserId?: string;

  @ApiProperty({
    description: 'OAuth scopes actually granted to the token (if valid).',
    required: false,
    type: [String],
  })
  scopes?: string[];

  @ApiProperty({
    description: 'Required scopes that the token does NOT grant (if valid).',
    required: false,
    type: [String],
  })
  missingScopes?: string[];

  @ApiProperty({
    description: 'Error code if validation failed.',
    enum: [
      'empty_token',
      'invalid_token',
      'sso_required',
      'github_unreachable',
    ],
    required: false,
  })
  error?:
    | 'empty_token'
    | 'invalid_token'
    | 'sso_required'
    | 'github_unreachable';

  @ApiProperty({
    description: 'Free-text error detail (if validation failed).',
    required: false,
  })
  message?: string;
}

export class GitHubSetupHealthResponseDto {
  @ApiProperty({
    description: 'True when the configured integration is reachable and valid.',
  })
  ok: boolean;

  @ApiProperty({
    description: 'Active auth mode (null when nothing is configured).',
    enum: GitHubAuthMethod,
    nullable: true,
  })
  mode: GitHubAuthMethod | null;

  @ApiProperty({
    description:
      'Mode-specific details. For github_app: appSlug, appId, installationsCount. For pat: note. On failure: error, message, status.',
    type: Object,
  })
  details: Record<string, unknown>;
}
