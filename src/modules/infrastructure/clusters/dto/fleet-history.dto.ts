import { ApiProperty } from '@nestjs/swagger';

export class FleetHistoryPointDto {
  @ApiProperty({ description: 'Instant this sample describes' })
  at: Date;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'number' },
    description:
      'How many nodes of each server type were alive. `unknown` is a node ' +
      'whose provider records no size — a BYOS machine, where the placeholder ' +
      'would otherwise read as a shape.',
  })
  byShape: Record<string, number>;

  @ApiProperty({ description: 'Total nodes alive, the sum over byShape' })
  nodes: number;

  @ApiProperty({
    description:
      'Fleet cost per hour, over the nodes whose price is known. Nodes ' +
      'counted in `unpricedNodes` contribute nothing rather than zero.',
  })
  hourlyEur: number;

  @ApiProperty({
    description: 'Nodes alive at this instant with no price to add',
  })
  unpricedNodes: number;
}

export class FleetHistoryDto {
  @ApiProperty() clusterId: string;
  @ApiProperty() from: Date;
  @ApiProperty() to: Date;
  @ApiProperty({ description: 'Seconds between samples' })
  stepSeconds: number;

  @ApiProperty({ type: [FleetHistoryPointDto] })
  points: FleetHistoryPointDto[];

  @ApiProperty({
    description:
      'Intervals in the window whose node row no longer exists. They are ' +
      'counted: the interval is what billing charged for, and the node table ' +
      'cascades on cluster delete while the intervals table has no foreign key.',
  })
  orphanedIntervals: number;

  @ApiProperty({
    description:
      'The subset of those still open. An open interval with no node row is ' +
      'the signature of that cascade, and the one case where counting can ' +
      'overstate the present.',
  })
  orphanedOpenIntervals: number;

  @ApiProperty({ nullable: true })
  message: string | null;
}
