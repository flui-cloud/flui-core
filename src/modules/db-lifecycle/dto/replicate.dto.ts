import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';

export type ReplicationTransport = 'auto' | 'internal' | 'external';

export class ReplicateDto {
  @ApiProperty({ description: 'Source database application id.' })
  @IsUUID()
  srcAppId: string;

  @ApiProperty({ description: 'Destination database application id.' })
  @IsUUID()
  dstAppId: string;

  @ApiPropertyOptional({
    description:
      'Wire path: auto picks internal (same cluster, service DNS) or external ' +
      '(cross-cluster, TLS over a NodePort on the source cluster).',
    enum: ['auto', 'internal', 'external'],
    default: 'auto',
  })
  @IsOptional()
  @IsIn(['auto', 'internal', 'external'])
  transport?: ReplicationTransport;
}
