import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DnsProvider } from '../../providers/enums/dns-provider.enum';
import { DnsReplicaStatus } from '../enums/dns-replica-status.enum';

export class DnsZoneReplicaResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  dnsZoneId: string;

  @ApiProperty({ enum: DnsProvider })
  dnsProvider: DnsProvider;

  @ApiProperty()
  providerZoneId: string;

  @ApiProperty({ enum: DnsReplicaStatus })
  status: DnsReplicaStatus;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  lastReconciledAt: Date | null;

  @ApiPropertyOptional({ nullable: true })
  errorMessage: string | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
