import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RemovalPreviewVolumeDto {
  @ApiProperty({ example: 'data-immich-postgres-0' })
  name: string;

  @ApiProperty({ example: 'user-a1b2c3' })
  namespace: string;

  @ApiProperty({ example: '9c3f…' })
  applicationId: string;

  @ApiProperty({ example: 'immich-postgres' })
  applicationName: string;

  @ApiPropertyOptional({
    example: '10Gi',
    description: 'What the claim asks for, as Kubernetes writes it',
  })
  requested: string | null;

  @ApiProperty({ example: 10737418240 })
  requestedBytes: number;

  @ApiProperty({ example: '10 GiB' })
  sizeLabel: string;

  @ApiPropertyOptional({ example: 'flui-shared' })
  storageClass: string | null;

  @ApiPropertyOptional({ example: 'Bound' })
  phase: string | null;

  @ApiProperty({
    enum: ['label', 'tracked-resource', 'volume-claim-template'],
    description:
      'How Flui knows the claim belongs to this application. ' +
      '`volume-claim-template` ones are the invisible kind: Kubernetes made ' +
      'them and only their name points back at the application.',
  })
  attributedBy: string;
}

export class RemovalPreviewApplicationDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  slug: string;
}

/**
 * What a removal is about to take away, before it takes it.
 *
 * Read `volumesKnown` before believing an empty `volumes`: when the cluster
 * cannot be reached the honest answer is "unknown", never "nothing".
 */
export class RemovalPreviewDto {
  @ApiProperty({ enum: ['catalog-install', 'application'] })
  removes: 'catalog-install' | 'application';

  @ApiProperty({ example: 'Uninstall Immich' })
  label: string;

  @ApiProperty({ type: [RemovalPreviewApplicationDto] })
  applications: RemovalPreviewApplicationDto[];

  @ApiProperty({ type: [RemovalPreviewVolumeDto] })
  volumes: RemovalPreviewVolumeDto[];

  @ApiProperty({ example: 10737418240 })
  totalBytes: number;

  @ApiProperty({ example: '10 GiB' })
  totalLabel: string;

  @ApiProperty({
    description:
      'False when the cluster could not be read. An empty `volumes` then ' +
      'means "not known", and no surface may render it as "no data".',
  })
  volumesKnown: boolean;

  @ApiPropertyOptional({
    example:
      'This also deletes 10 GiB of data in 1 volume. It cannot be undone.',
    description:
      'The one sentence every surface shows. Null only when the removal ' +
      'provably takes no storage with it.',
  })
  dataWarning: string | null;

  @ApiPropertyOptional({
    description: 'Why the volumes could not be listed, when they could not.',
  })
  note?: string;
}
