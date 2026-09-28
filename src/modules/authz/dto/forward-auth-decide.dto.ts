import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';

/**
 * The request a cluster's sign-in relay is holding, in fields of its own: a
 * forwarded header would be rewritten by any proxy between the relay and the
 * API.
 */
export class ForwardAuthDecideDto {
  @ApiPropertyOptional({
    description: 'Path and query the browser asked for on the protected host.',
  })
  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER)
  @IsOptional()
  @IsString()
  @MaxLength(8192)
  uri?: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({ description: 'HTTP method of the original request.' })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  method?: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    description: 'Accept header of the original request.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  accept?: string;

  @ApiPropertyOptional({
    description: 'Cookie header of the original request.',
  })
  @Sensitivity(Sensitivity.CREDENTIAL)
  @IsOptional()
  @IsString()
  @MaxLength(16384)
  cookie?: string;
}

export class ForwardAuthVerdictDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'Status the relay answers with: 200 lets the request through, 302 sends the browser to `location`, anything else refuses it.',
  })
  status: number;

  @Sensitivity(Sensitivity.TENANT_IDENTITY)
  @ApiPropertyOptional({
    description: 'Headers to hand to the application when the status is 200.',
  })
  headers?: Record<string, string>;

  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER)
  @ApiPropertyOptional()
  location?: string;

  @Sensitivity(Sensitivity.CREDENTIAL)
  @ApiPropertyOptional({ description: 'Set-Cookie for the protected host.' })
  setCookie?: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    description:
      'How long the relay may reuse a 200 for the same credential; never past its expiry.',
  })
  cacheSeconds?: number;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiPropertyOptional()
  message?: string;
}
