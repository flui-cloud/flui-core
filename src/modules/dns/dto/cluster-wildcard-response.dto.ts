import { ApiProperty } from '@nestjs/swagger';

/**
 * The one DNS record that decides whether a newly deployed application is
 * reachable straight away or about a minute later.
 *
 * Every application on a cluster is published at `<slug>.<cluster>.<zone>` and
 * points at the same address, so one wildcard covers all of them — including
 * the ones that do not exist yet, which is the part that matters: a name that
 * already resolves has nothing to propagate.
 */
export class ClusterWildcardResponseDto {
  @ApiProperty({
    example: 'published',
    enum: ['published', 'absent', 'foreign', 'unknown', 'unavailable'],
    description:
      '`published` — the record is there and points at this cluster. ' +
      '`absent` — it can be published, and nothing else is in the way. ' +
      '`foreign` — a wildcard is there but points somewhere else; Flui will not ' +
      'take it over, and applications keep getting their own records. ' +
      '`unknown` — the DNS provider could not be read just now. ' +
      '`unavailable` — the cluster has no address yet.',
  })
  status: string;

  @ApiProperty({
    example: '*.control-cluster.dawit.blog',
    nullable: true,
    description: 'The record itself.',
  })
  fqdn: string | null;

  @ApiProperty({
    example: '<application>.control-cluster.dawit.blog',
    nullable: true,
    description: 'What it covers, written the way a person reads it.',
  })
  hostnamePattern: string | null;

  @ApiProperty({ example: '203.0.113.10', nullable: true })
  expectedValue: string | null;

  @ApiProperty({
    example: null,
    nullable: true,
    description:
      'Where the record actually points. Differs from `expectedValue` only when the status is `foreign`.',
  })
  actualValue: string | null;
}
