import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class IssueJoinTokenDto {
  @ApiPropertyOptional({
    description:
      'Address the new node uses to reach the master k3s API. Defaults to the cluster master IP.',
  })
  @IsOptional()
  @IsString()
  masterIp?: string;

  @ApiPropertyOptional({
    description:
      'CIDR of the private network the nodes share (the host firewall must allow it for node-to-node k3s traffic). Defaults to the /24 of the master IP.',
  })
  @IsOptional()
  @IsString()
  nodeNetwork?: string;
}

export class IssuedJoinTokenResponseDto {
  @ApiProperty({
    description: 'Opaque single-use token (also embedded in command)',
  })
  token: string;

  @ApiProperty({ description: 'One-liner to run as root on the new host' })
  command: string;

  @ApiProperty({ description: 'Token expiry (ISO 8601)' })
  expiresAt: string;

  @ApiProperty()
  masterIp: string;

  @ApiPropertyOptional()
  nodeNetwork?: string;

  @ApiProperty({ description: 'k3s node name that will be registered' })
  serverName: string;
}

export class CompleteJoinDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  serverName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  privateIp?: string;
}
