import { ApiProperty } from '@nestjs/swagger';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';
import { AppEndpointResponseDto } from './app-endpoint-response.dto';
import type { SyncCertificateAction } from '../utils/endpoint-sync.core';

const CERTIFICATE_ACTIONS: SyncCertificateAction[] = [
  'not-required',
  'shared',
  'valid',
  'retried',
  'requested',
  'issuing',
  'waiting',
  'failed',
];

export class EndpointSyncDto {
  @ApiProperty({
    enum: CERTIFICATE_ACTIONS,
    description:
      'What the sync found or did about the certificate; `retried` means a failed one was ordered again.',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  certificate: SyncCertificateAction;

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  certificateRetried: boolean;

  @ApiProperty({
    type: [String],
    description: 'One sentence per part: address, route, certificate.',
  })
  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER)
  actions: string[];

  @ApiProperty({ description: 'The actions as one message.' })
  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER)
  says: string;
}

export class EndpointSyncResponseDto extends AppEndpointResponseDto {
  @ApiProperty({ type: EndpointSyncDto })
  @Sensitivity(Sensitivity.PUBLIC)
  sync: EndpointSyncDto;
}
