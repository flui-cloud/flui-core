import { ApiProperty } from '@nestjs/swagger';

export class ComponentImageTagsDto {
  @ApiProperty({ description: 'ghcr.io/flui-cloud/core image tag' })
  fluiApi!: string;

  @ApiProperty({ description: 'ghcr.io/flui-cloud/dashboard image tag' })
  fluiWeb!: string;

  @ApiProperty({ description: 'ghcr.io/flui-cloud/flui-authz image tag' })
  fluiAuthz!: string;
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
}
