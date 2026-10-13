import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';
import {
  SYSTEM_HOSTNAME_APPS,
  SystemHostnameApp,
} from '../utils/system-hostnames.util';

export class SystemHostnameDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ enum: SYSTEM_HOSTNAME_APPS })
  app: SystemHostnameApp;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  applicationId: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description: 'Name used under the domain when nobody chooses another',
    example: 'dashboard',
  })
  defaultLabel: string;

  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER, { screenOnly: true })
  @ApiPropertyOptional({
    nullable: true,
    description:
      'Name under the domain: the one already in use there, or the default. Null for a full address.',
    example: 'dashboard',
  })
  label: string | null;

  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER, { screenOnly: true })
  @ApiPropertyOptional({
    nullable: true,
    description: 'Full address, null while no domain is known',
    example: 'dashboard.example.com',
  })
  fqdn: string | null;

  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER, { screenOnly: true })
  @ApiPropertyOptional({
    nullable: true,
    description: 'Address the application answers on today, if any',
  })
  currentFqdn: string | null;
}

export class SystemHostnamesResponseDto {
  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER, { screenOnly: true })
  @ApiPropertyOptional({ nullable: true, example: 'example.com' })
  zoneName: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: [SystemHostnameDto] })
  hostnames: SystemHostnameDto[];
}

export class SystemHostnameChoiceDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ enum: SYSTEM_HOSTNAME_APPS })
  @IsIn(SYSTEM_HOSTNAME_APPS)
  app: SystemHostnameApp;

  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER, { screenOnly: true })
  @ApiPropertyOptional({
    description:
      'One name under the domain (wildcard certificate). Give either label or fqdn.',
    example: 'dashboard-demo',
  })
  @IsOptional()
  @IsString()
  @MaxLength(253)
  label?: string;

  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER, { screenOnly: true })
  @ApiPropertyOptional({
    description:
      'Full address (certificate per address). Give either label or fqdn.',
    example: 'dashboard.demo.example.com',
  })
  @IsOptional()
  @IsString()
  @MaxLength(253)
  fqdn?: string;
}

export class CheckSystemHostnamesDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    description:
      "Registered DNS zone the labels go under. Defaults to the cluster's primary zone.",
  })
  @IsOptional()
  @IsUUID()
  dnsZoneId?: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: [SystemHostnameChoiceDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(SYSTEM_HOSTNAME_APPS.length)
  @ValidateNested({ each: true })
  @Type(() => SystemHostnameChoiceDto)
  hostnames: SystemHostnameChoiceDto[];
}
