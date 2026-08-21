import { ApiProperty } from '@nestjs/swagger';

export class SandboxFootprintDto {
  @ApiProperty({ example: 500, description: 'Millicores one tenancy holds.' })
  cpu: number;

  @ApiProperty({ example: 512, description: 'MiB one tenancy holds.' })
  memory: number;

  @ApiProperty({
    example: 'measured',
    enum: ['measured', 'declared'],
    description:
      'Measured from the tenancies that exist, or the declared fallback when there are none yet.',
  })
  source: string;

  @ApiProperty({ example: 3, description: 'How many tenancies were averaged.' })
  sampledFrom: number;
}

/**
 * Why the sandbox is holding the number of warm tenancies it is holding.
 *
 * Every field is an input to one piece of arithmetic, and they are served
 * together because separately they mislead: a target of four means one thing
 * under a ceiling of five and another under a ceiling of forty.
 */
export class SandboxCapacityDto {
  @ApiProperty({ example: 2, description: 'Built and waiting for a visitor.' })
  warm: number;

  @ApiProperty({ example: 3, description: 'Held by somebody right now.' })
  live: number;

  @ApiProperty({ example: 4 })
  claimsLastHour: number;

  @ApiProperty({ example: 1.25 })
  claimsPerHourToday: number;

  @ApiProperty({
    example: 4,
    description: 'The rate the target is computed from: the higher of the two.',
  })
  demandPerHour: number;

  @ApiProperty({ example: 2, description: 'Warm tenancies wanted right now.' })
  target: number;

  @ApiProperty({
    example: 7,
    description: 'The most tenancies this cluster can hold, as it is today.',
  })
  ceiling: number;

  @ApiProperty({
    example: 202,
    description:
      'Seconds from starting a build to being able to hand it over — build plus the wait for the public address to resolve.',
  })
  readySeconds: number;

  @ApiProperty({ type: SandboxFootprintDto })
  footprint: SandboxFootprintDto;

  @ApiProperty({
    example: 0,
    description:
      'Visitors turned away because nothing was warm, since this process started. Not persisted: nobody who is refused leaves a row behind.',
  })
  fullRefusals: number;

  @ApiProperty({
    example:
      '4.0 claims an hour, and 202s to build and settle one, so about 0.2 would arrive during a build — keep 2 warm.',
  })
  reason: string;
}
