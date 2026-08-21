import { ApiProperty } from '@nestjs/swagger';

export class SandboxAllowedDto {
  @ApiProperty({ example: ['GET /applications/:id/**'] })
  routes: string[];

  @ApiProperty({ example: 'Operate your own application.' })
  why: string;

  @ApiProperty({
    example: 'full',
    enum: ['full', 'read-only', 'stand-in', 'closed'],
  })
  level: string;
}

/**
 * One part of the product and how much of it a guest gets. The interface reads
 * this to caption a section; it is never the text of an error.
 */
export class SandboxAreaDto {
  @ApiProperty({ example: 'cluster' })
  key: string;

  @ApiProperty({ example: 'The cluster you are on' })
  area: string;

  @ApiProperty({
    example: 'read-only',
    enum: ['full', 'read-only', 'stand-in', 'closed'],
  })
  level: string;

  @ApiProperty({ example: 'It is shared with every other guest on it.' })
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

  @ApiProperty({ type: [SandboxAreaDto] })
  areas: SandboxAreaDto[];

  @ApiProperty({ type: SandboxQuotaDto })
  quota: SandboxQuotaDto;
}
