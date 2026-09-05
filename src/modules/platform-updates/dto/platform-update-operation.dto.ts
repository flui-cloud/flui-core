import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';

export class PlatformUpdateComponentProgressDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  key: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  name: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ nullable: true })
  fromVersion: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  targetVersion: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ enum: ['pending', 'running', 'done', 'skipped', 'failed'] })
  status: string;
}

export class PlatformUpdateOperationDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  id: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ example: 'IN_PROGRESS' })
  status: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  fromVersion: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  targetVersion: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: [PlatformUpdateComponentProgressDto] })
  components: PlatformUpdateComponentProgressDto[];

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Database migrations this release applies.' })
  migrations: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ minimum: 0, maximum: 100 })
  progress: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({ nullable: true, description: 'Current step key.' })
  currentStep: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'True while the API is being replaced: the answer to this request comes from the pod on its way out, or from the one that replaced it.',
  })
  awaitingSelfRestart: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({ nullable: true })
  startedAt: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({ nullable: true })
  completedAt: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({ nullable: true })
  errorMessage: string | null;

  @Sensitivity(Sensitivity.TENANT_IDENTITY)
  @ApiPropertyOptional({
    nullable: true,
    description: 'Who started it. Null for an update started by no person.',
  })
  userId: string | null;
}
