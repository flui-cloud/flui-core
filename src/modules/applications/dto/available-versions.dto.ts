import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ApplicationSourceType } from '../enums/application-source-type.enum';
import { ApplicationReleaseDto } from './application-release.dto';

export class AvailableVersionDto {
  @ApiProperty({
    description: 'Primary version tag (semver, SHA, or named tag)',
  })
  tag: string;

  @ApiProperty({ description: 'Full pullable image reference' })
  imageRef: string;

  @ApiPropertyOptional({
    description:
      'GitHub Packages numeric version id. Required to call DELETE /image-registry/apps/:appId/ghcr/:versionId. Present for GHCR-backed sources only.',
  })
  versionId?: number;

  @ApiPropertyOptional({
    description: 'All tags pointing to this image version',
    type: [String],
  })
  allTags: string[];

  @ApiProperty()
  isCurrentlyDeployed: boolean;

  @ApiPropertyOptional()
  createdAt?: string;

  @ApiPropertyOptional()
  digest?: string;

  @ApiPropertyOptional({ description: 'DockerHub deploy suitability hint' })
  deployHint?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Supported platforms (DockerHub only)',
  })
  platforms?: string[];

  @ApiPropertyOptional({
    description:
      'Most recent release that targeted this image (any outcome). Null when this image was never deployed.',
    type: () => ApplicationReleaseDto,
    nullable: true,
  })
  lastRelease?: ApplicationReleaseDto | null;

  @ApiProperty({
    description:
      'Total number of releases that targeted this image, including FAILED and ROLLED_BACK.',
    example: 2,
  })
  releaseCount: number;

  @ApiProperty({
    description:
      'True when this is the most recent release ever attempted on the app (regardless of outcome). Distinct from isCurrentlyDeployed: a FAILED release can be the latest but not currently deployed.',
  })
  isLatestRelease: boolean;

  @ApiProperty({
    description:
      'Whether this application can actually be asked to run this version. False for an image built from another branch, or for a row that is only a moving tag. A listing that offers what cannot be run teaches people not to trust the rest of it.',
  })
  releasable: boolean;

  @ApiPropertyOptional({
    description:
      'Why it cannot be released, in one sentence. Null when it can.',
    nullable: true,
    example: 'Built from "staging", and this application deploys "main".',
  })
  notReleasableReason: string | null;
}

export class AvailableVersionsResponseDto {
  @ApiProperty({ enum: ApplicationSourceType })
  sourceType: ApplicationSourceType;

  @ApiPropertyOptional({ description: 'Currently deployed image reference' })
  currentImageRef: string | null;

  @ApiProperty({ type: [AvailableVersionDto] })
  versions: AvailableVersionDto[];

  @ApiPropertyOptional({
    description: 'Next page number for pagination (DockerHub only)',
    nullable: true,
  })
  nextPage: number | null;

  @ApiPropertyOptional({
    description:
      'For system apps: glob patterns of versions allowed by Flui curation (e.g. ["v4.*"]). null for user apps (no restriction).',
    type: [String],
    nullable: true,
  })
  allowedPatterns: string[] | null;
}
