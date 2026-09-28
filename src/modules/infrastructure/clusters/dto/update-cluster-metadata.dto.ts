import { ApiProperty } from '@nestjs/swagger';
import { IsObject } from 'class-validator';

/**
 * DTO for updating cluster metadata
 */
export class UpdateClusterMetadataDto {
  @ApiProperty({
    description:
      'Metadata to merge with the existing metadata. Only `byos` (host, port, user, nodeNetwork) is accepted; any other key is refused with 400.',
    example: {
      byos: { port: 2222, user: 'root' },
    },
  })
  @IsObject()
  metadata: Record<string, any>;
}
