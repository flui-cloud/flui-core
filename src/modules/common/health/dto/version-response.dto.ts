import { ApiProperty } from '@nestjs/swagger';

export class ComponentImageTagsDto {
  @ApiProperty({ description: 'ghcr.io/flui-cloud/core image tag' })
  fluiApi!: string;

  @ApiProperty({ description: 'ghcr.io/flui-cloud/dashboard image tag' })
  fluiWeb!: string;

  @ApiProperty({ description: 'ghcr.io/flui-cloud/flui-authz image tag' })
  fluiAuthz!: string;
}

export class ManifestSpecDto {
  @ApiProperty({ example: '@flui-cloud/spec' })
  package: string;

  @ApiProperty({
    example: '0.8.1',
    description:
      'The version compiled into this build — what it validates with.',
  })
  version: string;

  @ApiProperty({
    description:
      'The kind: Application JSON Schema, pinned to that version. The unpinned URL resolves to whatever the registry has today, which is not necessarily what this installation enforces.',
  })
  applicationSchemaUrl: string;
}

export class VersionResponseDto {
  @ApiProperty({
    description:
      'Platform release version this API build belongs to (compiled-in RELEASE manifest).',
    example: '0.12.1',
  })
  version!: string;

  @ApiProperty({
    description: 'Bootstrap-scripts git ref pinned by this release.',
    example: 'v0.5.4',
  })
  bootstrapRef!: string;

  @ApiProperty({
    description:
      'Pinned component image tags for this release. Env overrides (FLUI_*_IMAGE_TAG) win when set, so the values reflect what is actually deployed.',
    type: ComponentImageTagsDto,
  })
  components!: ComponentImageTagsDto;

  @ApiProperty({
    description:
      'The flui.yaml contract this build validates against, pinned to the version compiled in.',
    type: ManifestSpecDto,
  })
  manifestSpec!: ManifestSpecDto;
}
