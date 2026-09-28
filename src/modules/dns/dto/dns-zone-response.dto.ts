import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DnsProvider } from '../../providers/enums/dns-provider.enum';
import { DnsZoneReplicaResponseDto } from './dns-zone-replica-response.dto';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';

export class DnsZoneResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  providerZoneId: string;

  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER, { screenOnly: true })
  @ApiProperty()
  zoneName: string;

  @ApiProperty({ enum: DnsProvider })
  dnsProvider: DnsProvider;

  @ApiPropertyOptional()
  description: string;

  @ApiProperty({
    description: 'TTL applied to records Flui writes into this zone (seconds).',
  })
  recordTtlSeconds: number;

  @ApiProperty({
    type: [DnsZoneReplicaResponseDto],
    description:
      'Redundancy replicas of this zone on additional DNS providers.',
  })
  replicas: DnsZoneReplicaResponseDto[];

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
