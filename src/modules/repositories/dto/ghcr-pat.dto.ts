import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsNotEmpty,
  IsString,
  Matches,
  MinLength,
} from 'class-validator';

export enum CredentialStatus {
  MISSING = 'MISSING',
  VALID = 'VALID',
  EXPIRING_SOON = 'EXPIRING_SOON',
  EXPIRED = 'EXPIRED',
  INVALID = 'INVALID',
  UNKNOWN_EXPIRY = 'UNKNOWN_EXPIRY',
}

export enum CredentialKind {
  GITHUB_APP = 'GITHUB_APP',
  /** The person's own GitHub token, where the installation connects GitHub with tokens. */
  GITHUB_PAT = 'GITHUB_PAT',
  GHCR_PAT = 'GHCR_PAT',
  PROVIDER = 'PROVIDER',
}

const PAT_PATTERN = /^(ghp_|github_pat_)/;

export class SaveGhcrPatDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @Matches(PAT_PATTERN, {
    message: 'Token must start with ghp_ or github_pat_',
  })
  @ApiProperty({
    description: 'GitHub Personal Access Token (ghp_xxx or github_pat_xxx)',
    example: 'ghp_xxxxxxxxxxxxxxxxxxxx',
  })
  token: string;

  @IsDateString()
  @ApiProperty({
    description: 'User-supplied PAT expiry, ISO 8601, must be in the future',
    example: '2026-11-05T00:00:00.000Z',
  })
  expiresAt: string;
}

export class UpdateGhcrPatExpiryDto {
  @IsDateString()
  @ApiProperty({
    description: 'New expiry date, ISO 8601, must be in the future',
    example: '2027-05-05T00:00:00.000Z',
  })
  expiresAt: string;
}

export class GhcrPatStatusDto {
  @ApiProperty({ description: 'Whether a PAT is configured for the user' })
  configured: boolean;

  @ApiPropertyOptional({ enum: CredentialStatus })
  status?: CredentialStatus;

  @ApiPropertyOptional({ description: 'Expiry date, ISO 8601', nullable: true })
  expiresAt?: Date | null;

  @ApiPropertyOptional({ description: 'Days until expiry (server-computed)' })
  daysUntilExpiry?: number | null;

  @ApiPropertyOptional({ description: 'When PAT was last rotated' })
  lastRotatedAt?: Date | null;

  @ApiPropertyOptional({
    description: 'When PAT was last verified with GitHub',
  })
  lastVerifiedAt?: Date | null;

  @ApiPropertyOptional({ description: 'GitHub login owning the PAT' })
  githubLogin?: string;

  @ApiPropertyOptional({ description: 'Granted scopes', type: [String] })
  scopes?: string[];

  @ApiPropertyOptional({
    description:
      'False when this instance keeps built images in its own registry: no GHCR token is needed to pull them.',
  })
  needed?: boolean;
}

export class CredentialsStatusItemDto {
  @ApiProperty({ enum: CredentialKind })
  kind: CredentialKind;

  @ApiProperty({ description: 'Display label' })
  label: string;

  @ApiProperty({ enum: CredentialStatus })
  status: CredentialStatus;

  @ApiPropertyOptional({ description: 'Expiry, ISO 8601', nullable: true })
  expiresAt: Date | null;

  @ApiPropertyOptional({ description: 'Days until expiry', nullable: true })
  daysUntilExpiry: number | null;

  @ApiPropertyOptional({
    description: 'Provider id, present for PROVIDER kind',
  })
  providerId?: string;

  @ApiPropertyOptional({ description: 'Frontend route hint' })
  actionUrl?: string;
}

export class CredentialsStatusResponseDto {
  @ApiProperty({ enum: CredentialStatus })
  overallStatus: CredentialStatus;

  @ApiProperty({ type: [CredentialsStatusItemDto] })
  items: CredentialsStatusItemDto[];
}
