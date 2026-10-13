import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';

export class SandboxVisitorAdmissionRequestDto {
  @ApiPropertyOptional({
    description:
      'The Cloudflare Turnstile token the page obtained. Required from a browser when the instance checks browsers.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  turnstileToken?: string;

  @ApiPropertyOptional({
    description:
      'An admission for the command line sign-in rather than the browser one. Counted the same, with no browser check.',
  })
  @IsOptional()
  @IsBoolean()
  cli?: boolean;
}

export class SandboxVisitorAdmissionDto {
  @Sensitivity(Sensitivity.CREDENTIAL, { conditional: true })
  @ApiProperty({
    description:
      'A single-use ticket into the visitors’ sign-in. Pass it as `login_hint` when starting the sign-in of a "try" application.',
  })
  nonce: string;

  @ApiProperty({ example: 120 })
  expiresInSeconds: number;
}
