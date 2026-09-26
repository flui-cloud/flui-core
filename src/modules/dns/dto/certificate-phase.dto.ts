import { ApiProperty } from '@nestjs/swagger';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';
import type { CertificatePhaseStep } from '../utils/certificate-phase.core';

export class CertificatePhaseDto {
  @ApiProperty({ enum: ['none', 'publishing', 'issuing', 'issued', 'failed'] })
  @Sensitivity(Sensitivity.PUBLIC)
  step: CertificatePhaseStep;

  @ApiProperty({ example: 'Name published, certificate on its way' })
  @Sensitivity(Sensitivity.PUBLIC)
  label: string;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Plain explanation; may name the host and its address.',
  })
  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER)
  detail: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'The raw message from the certificate machinery.',
  })
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  technical: string | null;
}
