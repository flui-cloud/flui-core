import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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

  @ApiPropertyOptional({
    description: 'Available regions discovered',
    type: [Object],
  })
  availableRegions?: Array<{
    id: string;
    name: string;
    location: string;
  }>;
}
