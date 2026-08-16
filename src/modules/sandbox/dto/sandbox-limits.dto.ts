import { ApiProperty } from '@nestjs/swagger';

export class SandboxAllowedDto {
  @ApiProperty({ example: ['GET /applications/:id/**'] })
  routes: string[];

  @ApiProperty({ example: 'Operate your own application.' })
  why: string;
}

export class SandboxDeniedDto {
  @ApiProperty({ example: 'Infrastructure — clusters, servers, nodes' })
  area: string;

  @ApiProperty({ example: 'The instance is shared.' })
  why: string;
}

export class SandboxQuotaDto {
  @ApiProperty({ example: '2 cores' }) cpu: string;
  @ApiProperty({ example: '3Gi' }) memory: string;
  @ApiProperty({ example: '5Gi' }) storage: string;
  @ApiProperty({ example: 12 }) pods: number;
}

export class SandboxLimitsDto {
  @ApiProperty({ type: [SandboxAllowedDto] })
  allowed: SandboxAllowedDto[];

  @ApiProperty({ type: [SandboxDeniedDto] })
  denied: SandboxDeniedDto[];

  @ApiProperty({ type: SandboxQuotaDto })
  quota: SandboxQuotaDto;
}
