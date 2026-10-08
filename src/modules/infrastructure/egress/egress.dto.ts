import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';
import { EGRESS_PROTOCOLS, EgressProtocol } from './egress-policy.core';

export class EgressPortDto {
  @ApiProperty({ example: 443, minimum: 1, maximum: 65535 })
  @Sensitivity(Sensitivity.PUBLIC)
  @IsInt()
  @Min(1)
  @Max(65535)
  port: number;

  @ApiProperty({ enum: EGRESS_PROTOCOLS, example: 'TCP' })
  @Sensitivity(Sensitivity.PUBLIC)
  @IsIn(EGRESS_PROTOCOLS)
  protocol: EgressProtocol;
}

export class SetEgressPolicyDto {
  @ApiProperty({
    type: [EgressPortDto],
    description:
      'Ports applications may reach outside the cluster. An empty list closes every port; to open everything, remove the rule.',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  @IsArray()
  @ArrayMaxSize(64)
  @ValidateNested({ each: true })
  @Type(() => EgressPortDto)
  ports: EgressPortDto[];
}

export class EgressPolicyDto {
  @ApiProperty({ description: 'True when no rule is set: every port is open' })
  @Sensitivity(Sensitivity.PUBLIC)
  open: boolean;

  @ApiProperty({ type: [EgressPortDto], description: 'Empty when open' })
  @Sensitivity(Sensitivity.PUBLIC)
  ports: EgressPortDto[];

  @ApiProperty({
    example:
      'Outbound traffic leaving the cluster is allowed on ports 80, 443; for any other port ask your administrator.',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  summary: string;
}

export class EgressFailureDto {
  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  namespace: string;

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  error: string;
}

export class EgressPolicyChangeDto extends EgressPolicyDto {
  @ApiProperty({
    description: 'How many application spaces now carry the rule',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  applied: number;

  @ApiProperty({
    type: [EgressFailureDto],
    description:
      'Where the rule could not be written; the next deploy there writes it again',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  failed: EgressFailureDto[];
}
