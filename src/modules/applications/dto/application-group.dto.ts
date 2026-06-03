import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ApplicationCategory } from '../enums/application-category.enum';
import { ApplicationStatus } from '../enums/application-status.enum';
import { ApplicationResponseDto } from './application-response.dto';

export enum ApplicationGroupType {
  STANDALONE = 'standalone',
  COMPOSED = 'composed',
}

export class ApplicationGroupDto {
  @ApiProperty({
    description:
      'Group identity: the CatalogInstall id for composed groups, the application id for standalone.',
  })
  id: string;

  @ApiProperty({ enum: ApplicationGroupType })
  type: ApplicationGroupType;

  @ApiProperty({
    description:
      'Bundle display name (e.g. "Nextcloud") for composed groups, or the app name for standalone.',
  })
  name: string;

  @ApiProperty()
  slug: string;

  @ApiProperty({
    enum: ApplicationStatus,
    description:
      'Worst-of status across components for composed groups; the app status for standalone.',
  })
  status: ApplicationStatus;

  @ApiProperty({ enum: ApplicationCategory })
  category: ApplicationCategory;

  @ApiProperty()
  clusterId: string;

  @ApiPropertyOptional({
    description:
      'Public URL of the primary component, when the bundle exposes one.',
  })
  url?: string;

  @ApiPropertyOptional({
    description: 'Catalog slug for catalog-installed groups.',
  })
  catalogSlug?: string;

  @ApiPropertyOptional()
  catalogInstallId?: string;

  @ApiPropertyOptional({
    description: 'Id of the primary component within a composed group.',
  })
  primaryComponentId?: string;

  @ApiProperty({ description: 'Number of component apps (1 for standalone).' })
  componentCount: number;

  @ApiProperty({
    type: [ApplicationResponseDto],
    description:
      'Component apps; a single-element array for standalone groups.',
  })
  components: ApplicationResponseDto[];

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
