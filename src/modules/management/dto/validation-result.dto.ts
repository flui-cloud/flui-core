import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProviderRegion } from '../entities/provider-region.entity';
import { ProviderRegionDto } from './provider-capabilities.dto';

export class ValidationResultDto {
  @ApiProperty({ description: 'Whether validation passed' })
  success: boolean;

  @ApiPropertyOptional({ description: 'Validation error message' })
  message?: string;

  @ApiPropertyOptional({ description: 'Validation details' })
  details?: {
    apiAccess?: boolean;
    readPermissions?: boolean;
    writePermissions?: boolean;
    regionsDiscovered?: number;
    models?: string[];
    [key: string]: any;
  };

  /**
   * The same shape the regions endpoint returns. It has to be: the
   * configuration wizard renders whichever of the two it gets, and a narrower
   * shape here silently drops the fields it reads — the region shows up with
   * no country and marked unavailable.
   */
  @ApiPropertyOptional({
    description: 'Available regions discovered',
    type: [ProviderRegionDto],
  })
  availableRegions?: ProviderRegion[];
}
