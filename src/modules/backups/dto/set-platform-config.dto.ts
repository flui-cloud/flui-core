import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUrl, Matches } from 'class-validator';

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
      "Dead-man's-switch URL the master POSTs to every 5 min while backups are fresh (healthchecks.io / ntfy / Uptime-Kuma push).",
  })
  @IsOptional()
  @IsUrl({ require_tld: false })
  heartbeatUrl?: string;
}
