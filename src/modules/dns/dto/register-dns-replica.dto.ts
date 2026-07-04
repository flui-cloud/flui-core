import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { DnsProvider } from '../../providers/enums/dns-provider.enum';

export class RegisterDnsReplicaDto {
  @ApiProperty({
    enum: DnsProvider,
    description:
      'The provider that will host this redundancy replica of the zone. Must differ from the primary provider.',
  })
  @IsEnum(DnsProvider)
  dnsProvider: DnsProvider;

  @ApiPropertyOptional({
    description:
      'Provider zone identifier (Hetzner numeric zone id; Scaleway zone name). Omit to look it up by zone name in the provider account.',
  })
  @IsOptional()
  @IsString()
  providerZoneId?: string;
}
