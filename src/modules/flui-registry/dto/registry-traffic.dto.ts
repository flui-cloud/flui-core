import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';
import { REGISTRY_TRAFFIC_WINDOWS } from '../services/registry-traffic.service';

export class RegistryTrafficRequestsDto {
  @ApiProperty({ description: 'Manifests and layers fetched or checked' })
  @Sensitivity(Sensitivity.PUBLIC)
  pulls: number;

  @ApiProperty({ description: 'Layers and manifests written' })
  @Sensitivity(Sensitivity.PUBLIC)
  pushes: number;

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  deletes: number;
}

export class RegistryTrafficOutcomesDto {
  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  ok: number;

  @ApiProperty({
    description: 'Over quota, too large, or over the rate limit',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  refused: number;

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  notFound: number;

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  failed: number;
}

export class RegistryTrafficDto {
  @ApiProperty({ enum: REGISTRY_TRAFFIC_WINDOWS })
  @Sensitivity(Sensitivity.PUBLIC)
  window: string;

  @ApiProperty({ type: RegistryTrafficRequestsDto })
  @Sensitivity(Sensitivity.PUBLIC)
  requests: RegistryTrafficRequestsDto;

  @ApiProperty({ type: RegistryTrafficOutcomesDto })
  @Sensitivity(Sensitivity.PUBLIC)
  outcomes: RegistryTrafficOutcomesDto;

  @ApiProperty({ description: 'Bytes pushed into the registry' })
  @Sensitivity(Sensitivity.PUBLIC)
  bytesIn: number;

  @ApiProperty({ description: 'Bytes pulled from the registry' })
  @Sensitivity(Sensitivity.PUBLIC)
  bytesOut: number;

  @ApiProperty({ description: 'Busiest five minutes, bytes per second in' })
  @Sensitivity(Sensitivity.PUBLIC)
  peakBytesPerSecondIn: number;

  @ApiProperty({ description: 'Busiest five minutes, bytes per second out' })
  @Sensitivity(Sensitivity.PUBLIC)
  peakBytesPerSecondOut: number;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'On a bucket, bytes read from it to serve pulls: what its provider may bill as egress',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  readFromBucketBytes: number | null;
}
