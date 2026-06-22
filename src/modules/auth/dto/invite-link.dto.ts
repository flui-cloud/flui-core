import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class InviteLinkResultDto {
  @ApiProperty({
    description:
      'Copyable link the user opens to set up their account. No email required. Path is configurable via OIDC_INVITE_LINK_TEMPLATE.',
  })
  inviteLink: string;

  @ApiProperty({
    description:
      'Raw provider invite code — authoritative fallback if the link path needs adjusting.',
  })
  inviteCode: string;

  @ApiProperty()
  userId: string;

  @ApiPropertyOptional()
  organizationId?: string;
}
