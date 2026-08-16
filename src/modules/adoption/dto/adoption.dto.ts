import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class AdoptionTokenResponseDto {
  @ApiProperty({
    description:
      'Shown once. It expires in an hour and can be spent exactly once — reissue rather than store it.',
  })
  token: string;

  @ApiProperty()
  expiresAt: string;

  @ApiProperty()
  clusterId: string;
}

export class RegisterAdoptionCaDto {
  @ApiProperty({
    description:
      'The PUBLIC half of an SSH certificate authority, in OpenSSH format. A private key sent here would be rejected — this installation never needs one.',
    example: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5... flui-ca',
  })
  @IsString()
  @MaxLength(4096)
  // Anchored so a key body cannot smuggle a second line past the check; the
  // private-key header does not match, which is the mistake worth catching.
  @Matches(
    /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp\d+)\s+[A-Za-z0-9+/=]+(\s+\S+)?$/,
    {
      message:
        'Not an OpenSSH public key. Pass the contents of ca_key.pub, never ca_key.',
    },
  )
  publicKey: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(128)
  name?: string;
}

export class RegisterAdoptionCaResponseDto {
  @ApiProperty()
  fingerprint: string;

  @ApiProperty({
    description:
      'False until the nodes themselves trust the authority. Registering it here is the installation agreeing to it; enrolment is a separate step.',
  })
  enrolledOnNodes: boolean;

  @ApiProperty()
  message: string;
}
