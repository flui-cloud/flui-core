import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsString, Matches, Max, Min } from 'class-validator';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';

export class QueueScalingViewDto {
  @Sensitivity(Sensitivity.PUBLIC) @ApiProperty() stream: string;
  @Sensitivity(Sensitivity.PUBLIC) @ApiProperty() consumer: string;
  @Sensitivity(Sensitivity.PUBLIC) @ApiProperty() lagThreshold: number;
  @Sensitivity(Sensitivity.PUBLIC) @ApiProperty() min: number;
  @Sensitivity(Sensitivity.PUBLIC) @ApiProperty() max: number;
}

export class AppMessagingDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  applicationId: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  connected: boolean;

  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER)
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'nats://flui-nats.flui-system.svc.cluster.local:4222',
  })
  url: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Public key of the application’s NATS account.',
  })
  account: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ nullable: true, type: QueueScalingViewDto })
  queueScaling: QueueScalingViewDto | null;
}

const NATS_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export class QueueScalingDto {
  @ApiProperty({
    example: 'ORDERS',
    description: 'JetStream stream in the application’s account.',
  })
  @IsString()
  @Matches(NATS_NAME)
  stream: string;

  @ApiProperty({
    example: 'mailer',
    description: 'Durable consumer whose backlog is measured.',
  })
  @IsString()
  @Matches(NATS_NAME)
  consumer: string;

  @ApiProperty({
    example: 20,
    description: 'Messages waiting per replica before another one is added.',
  })
  @IsInt()
  @Min(1)
  @Max(100000)
  lagThreshold: number;

  @ApiProperty({
    example: 0,
    description: 'Replicas while the queue is empty; 0 stops the worker.',
  })
  @IsInt()
  @Min(0)
  @Max(50)
  min: number;

  @ApiProperty({ example: 5 })
  @IsInt()
  @Min(1)
  @Max(50)
  max: number;
}

export class CreateQueueDto {
  @ApiProperty({
    example: 'ORDERS',
    description: 'Stream name; the queue takes the subjects NAME and NAME.>',
  })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,60}$/)
  name: string;

  @ApiProperty({
    example: 168,
    description: 'Hours a message is kept when nobody handles it.',
  })
  @IsInt()
  @Min(1)
  @Max(24 * 365)
  maxAgeHours: number;

  @ApiProperty({
    example: 5,
    description: 'Deliveries before a message is given up on.',
  })
  @IsInt()
  @Min(1)
  @Max(100)
  maxDeliver: number;

  @ApiProperty({
    example: true,
    description: 'Keep the messages given up on in NAME_DLQ.',
  })
  @IsBoolean()
  deadLetter: boolean;
}

export class QueueViewDto {
  @Sensitivity(Sensitivity.PUBLIC) @ApiProperty() name: string;
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: [String] })
  subjects: string[];
  @Sensitivity(Sensitivity.PUBLIC) @ApiProperty() maxAgeHours: number;
  @Sensitivity(Sensitivity.PUBLIC) @ApiProperty() maxDeliver: number;
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Messages waiting for the worker.' })
  waiting: number;
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Delivered, not yet acknowledged.' })
  inFlight: number;
  @Sensitivity(Sensitivity.PUBLIC) @ApiProperty() redelivered: number;
  @Sensitivity(Sensitivity.PUBLIC) @ApiProperty() consumers: number;
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ nullable: true, type: Number })
  deadLetters: number | null;
}
