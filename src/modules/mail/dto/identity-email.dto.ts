import { ApiProperty } from '@nestjs/swagger';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';

export class IdentityEmailStatusDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    enum: ['active', 'attention', 'not_configured', 'error'],
    description:
      'active: sign-in mail goes through Flui. attention: it is pointed at Flui but something is ' +
      'missing, see reason. not_configured: the identity provider is left as it is. error: the ' +
      'last sync failed.',
  })
  state: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    nullable: true,
    enum: [
      'identity_provider_unreachable',
      'endpoint_unknown',
      'no_transactional_connection',
      'no_sender',
      'sender_not_ready',
      'sync_failed',
    ],
  })
  reason: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    nullable: true,
    example: 'scaleway-tem',
    description: 'The provider carrying transactional mail now.',
  })
  mailProvider: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    nullable: true,
    description: "The email provider's id at the identity provider.",
  })
  providerId: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  active: boolean;

  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER)
  @ApiProperty({
    nullable: true,
    description: 'Where the identity provider posts its mail.',
  })
  endpoint: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ nullable: true })
  lastSyncAt: string | null;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({ nullable: true })
  lastSyncError: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ nullable: true })
  lastDeliveryAt: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ nullable: true })
  lastErrorAt: string | null;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({ nullable: true })
  lastError: string | null;
}
