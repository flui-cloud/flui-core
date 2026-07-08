import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { CertificateProvider } from '../../providers/enums/certificate-provider.enum';
import { CertChallenge } from '../enums/cert-challenge.enum';
import { HostnameMode } from '../enums/hostname-mode.enum';

export class UpdateAppEndpointDto {
  @ApiPropertyOptional({ example: 'grafana.staging.flui.cloud' })
  @IsOptional()
  @IsString()
  fqdn?: string;

  @ApiPropertyOptional({
    description:
      'Reassign to a different DNS zone, or pass null to switch to BYOD mode.',
    nullable: true,
    type: String,
  })
  @IsOptional()
  @IsUUID()
  clusterDnsZoneId?: string | null;

  @ApiPropertyOptional({
    enum: CertificateProvider,
    description:
      'Override the certificate provider for this endpoint. ' +
      'Set to LETS_ENCRYPT to promote from staging to production.',
  })
  @IsOptional()
  @IsEnum(CertificateProvider)
  certificateProvider?: CertificateProvider;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  certificateRequired?: boolean;

  @ApiPropertyOptional({
    enum: CertChallenge,
    description:
      'Switch the ACME challenge type. IP-mode endpoints can only use HTTP-01.',
  })
  @IsOptional()
  @IsEnum(CertChallenge)
  certChallenge?: CertChallenge;

  @ApiPropertyOptional({
    enum: HostnameMode,
    description:
      'Switch the hostname source. Changing IP↔DOMAIN regenerates the FQDN ' +
      'unless an explicit fqdn is also provided.',
  })
  @IsOptional()
  @IsEnum(HostnameMode)
  hostnameMode?: HostnameMode;
}
