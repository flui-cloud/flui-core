import { ApiProperty } from '@nestjs/swagger';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';
import {
  ContainerResourcesDto,
  ResourcesConsequenceDto,
} from '../../applications/dto/app-management.dto';

export class ProposalReasonDto {
  @ApiProperty({ enum: ['oom', 'near-limit', 'above-request'] })
  @Sensitivity(Sensitivity.PUBLIC)
  kind: 'oom' | 'near-limit' | 'above-request';

  @ApiProperty()
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  sentence: string;
}

export class ResourceProposalDto {
  @ApiProperty({ description: 'The container the proposal is for' })
  @Sensitivity(Sensitivity.PUBLIC)
  containerName: string;

  @ApiProperty({ type: ContainerResourcesDto, description: 'What it has now' })
  @Sensitivity(Sensitivity.PUBLIC)
  currentRequests: ContainerResourcesDto;

  @ApiProperty({ type: ContainerResourcesDto })
  @Sensitivity(Sensitivity.PUBLIC)
  currentLimits: ContainerResourcesDto;

  @ApiProperty({ type: [ProposalReasonDto] })
  @Sensitivity(Sensitivity.PUBLIC)
  reasons: ProposalReasonDto[];

  @ApiProperty({
    type: ResourcesConsequenceDto,
    description: 'What would be written and where the replicas would then run',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  consequence: ResourcesConsequenceDto;

  @ApiProperty({
    description:
      'Applying replaces the pods. For an application with one replica or its own volume this is a stop while the new pod starts.',
  })
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  restart: string;

  @ApiProperty({
    nullable: true,
    description:
      'When the limit rises: whether the application uses the memory without its own configuration changing too',
  })
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  configurationNote: string | null;

  @ApiProperty({
    nullable: true,
    description: 'The out-of-memory diagnosis it resolves',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  diagnosisId: string | null;
}

export class ResourceProposalResponseDto {
  @ApiProperty({
    type: ResourceProposalDto,
    nullable: true,
    description: 'Null when nothing asks for a change',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  proposal: ResourceProposalDto | null;

  @ApiProperty({
    description:
      'Whether a week of memory use could be read; without it only an out-of-memory stop can propose',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  usageRead: boolean;
}
