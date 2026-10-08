import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
} from 'class-validator';

export class SetPlatformConfigDto {
  @ApiProperty({
    description:
      'Operator age recipient (age1…) the master seals its recovery bundle to. Public; the private identity stays on the operator laptop.',
  })
  @IsString()
  @Matches(/^age1[0-9a-z]+$/, {
    message: 'recipient must be a valid age recipient (age1…)',
  })
  recipient: string;

  @ApiPropertyOptional({
    description:
      "Dead-man's-switch URL the master POSTs to every 5 min while the installation is healthy and its backups are fresh (healthchecks.io / ntfy / Uptime-Kuma push). Left out, the current one stays.",
  })
  @IsOptional()
  @IsUrl({ require_tld: false })
  heartbeatUrl?: string;

  @ApiPropertyOptional({
    description:
      'Stop the heartbeat: forget the URL. Ignored when heartbeatUrl is set.',
  })
  @IsOptional()
  @IsBoolean()
  clearHeartbeat?: boolean;
}
