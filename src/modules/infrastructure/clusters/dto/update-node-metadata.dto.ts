import { ApiProperty } from '@nestjs/swagger';
import { IsObject } from 'class-validator';

/**
 * DTO for updating node metadata
 */
export class UpdateNodeMetadataDto {
  @ApiProperty({
    description:
      'Node metadata is kept by Flui; every key is currently refused with 400.',
    example: {},
  })
  @IsObject()
  metadata: Record<string, any>;
}
