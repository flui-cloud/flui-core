import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class OrphanedClaimDto {
  @ApiProperty({ example: 'data-uptime-kuma-0' })
  name: string;

  @ApiProperty({ example: 'user-a1b2c3' })
  namespace: string;

  @ApiPropertyOptional({ example: '10Gi' })
  requested: string | null;

  @ApiProperty({ example: 10737418240 })
  requestedBytes: number;

  @ApiProperty({ example: '10 GiB' })
  sizeLabel: string;

  @ApiPropertyOptional({ example: 'flui-shared' })
  storageClass: string | null;

  @ApiPropertyOptional({ example: 'Bound' })
  phase: string | null;

  @ApiPropertyOptional({ description: 'When Kubernetes created the claim' })
  createdAt: string | null;

  @ApiPropertyOptional({
    description:
      'The application that owned it, when the claim still names one and that ' +
      'application has since been deleted.',
  })
  lastKnownApplication?: { id: string; name: string; deletedAt: string | null };

  @ApiProperty({
    example: 'no application, no StatefulSet and no pod refers to it',
    description: 'Why this claim is considered abandoned.',
  })
  reason: string;
}

export class OrphanedClaimsDto {
  @ApiProperty()
  clusterId: string;

  @ApiProperty({
    description: 'Namespaces examined — the ones Flui puts applications in.',
    type: [String],
  })
  namespacesScanned: string[];

  @ApiProperty({ type: [OrphanedClaimDto] })
  claims: OrphanedClaimDto[];

  @ApiProperty({ example: 21474836480 })
  totalBytes: number;

  @ApiProperty({ example: '20 GiB' })
  totalLabel: string;

  @ApiPropertyOptional({
    description:
      'Set when the scan could not run; the list is then empty and unproven.',
  })
  note?: string;
}
