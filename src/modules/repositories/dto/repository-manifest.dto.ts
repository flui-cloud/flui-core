import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RepositoryManifestEntryDto {
  @ApiProperty({
    description: 'Manifest path relative to the repository root',
    example: 'api/flui.yaml',
  })
  path: string;

  @ApiProperty({
    description:
      'Whether the manifest is a valid kind: Application flui.cloud/v1beta1 manifest (deployable from this flow)',
  })
  valid: boolean;

  @ApiPropertyOptional({
    description:
      'Manifest kind as declared in the YAML (e.g. Application, CatalogApp)',
  })
  kind?: string;

  @ApiPropertyOptional({ description: 'metadata.name when valid' })
  name?: string;

  @ApiPropertyOptional({ description: 'deploy.port when valid' })
  port?: number;

  @ApiPropertyOptional({
    description: 'Validation error when not valid',
  })
  validationError?: string;

  @ApiPropertyOptional({
    description:
      'Non-fatal advisories for a valid manifest: fields the spec accepts but ' +
      'the runtime does not yet apply (x-flui-status: planned). Omitted when none.',
    type: [String],
  })
  warnings?: string[];

  @ApiProperty({ description: 'Raw flui.yaml content' })
  content: string;

  @ApiPropertyOptional({
    description: 'Parsed manifest (kind: Application) when valid',
    type: Object,
  })
  manifest?: Record<string, unknown>;
}

export class RepositoryManifestsDto {
  @ApiProperty({ description: 'Git ref the manifests were read from' })
  branch: string;

  @ApiProperty({
    description:
      'flui.yaml manifests discovered at the repository root and in subdirectories (monorepo). Empty when the repo has none.',
    type: [RepositoryManifestEntryDto],
  })
  manifests: RepositoryManifestEntryDto[];
}
