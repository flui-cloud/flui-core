import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';

export class PlatformComponentUpdateDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ example: 'fluiApi' })
  key: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ example: 'Flui API' })
  name: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ example: 'Control plane API' })
  role: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'The workload this component is, as it is named on the cluster.',
    example: 'flui-api',
  })
  deploymentName: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'Whether the component exists on this installation. False for an optional component that was never installed — flui-authz is the one that is genuinely optional.',
  })
  installed: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'True when the version was read from the cluster. False when the cluster could not be reached and the answer falls back to the pinned tag, which says what would be installed rather than what is.',
  })
  observed: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    nullable: true,
    description:
      'Image tag running on the cluster right now. Null when the component is not installed, or when its image is pinned by digest and carries no tag.',
    example: '0.13.0-rc.1',
  })
  installedVersion: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    nullable: true,
    description:
      'Image tag the available release pins. Null when no release is available.',
    example: '0.14.0',
  })
  targetVersion: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'False when the running image is pinned to something that is not a release version — a commit build or a moving tag. Such a component is never "on its release version", whatever the version comparison says.',
  })
  installedIsRelease: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'True when the release moves this component.' })
  changed: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'True for the component whose rollout restarts the control plane — the API itself.',
  })
  restartsControlPlane: boolean;
}

export class PlatformUpdateAdvisoryDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    enum: ['info', 'warning', 'blocker'],
    description:
      'A blocker means the release cannot be applied from here; the reason is in the detail.',
  })
  level: 'info' | 'warning' | 'blocker';

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ example: '2 database migrations will run' })
  title: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  detail: string;
}

export class PlatformUpdateStatusDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description: 'Release this API build belongs to.',
    example: '0.13.0-rc.1',
  })
  installedVersion: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    nullable: true,
    description: 'Newest published release above the installed one, if any.',
    example: '0.14.0',
  })
  availableVersion: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  updateAvailable: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'True when the available release can be applied from the dashboard. False with a blocker advisory when it needs the CLI.',
  })
  applicable: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({ nullable: true, example: '2026-09-02T09:00:00.000Z' })
  publishedAt: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    type: [String],
    description: 'Release notes, newest release only.',
  })
  notes: string[];

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'Database migrations the available release applies at start-up.',
    example: 2,
  })
  migrations: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: [PlatformComponentUpdateDto] })
  components: PlatformComponentUpdateDto[];

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: [PlatformUpdateAdvisoryDto] })
  advisories: PlatformUpdateAdvisoryDto[];

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'When the release manifest was last fetched.' })
  checkedAt: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    nullable: true,
    description:
      'Why the check could not be completed. When set, the answer describes the installed version only.',
  })
  checkError: string | null;
}
