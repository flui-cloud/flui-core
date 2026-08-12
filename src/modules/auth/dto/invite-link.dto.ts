import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

export class InviteLinkRequestDto {
  @ApiPropertyOptional({
    default: false,
    description:
      'Email the link to the user as well as returning it. Opt-in: the link is the product, ' +
      'the email is a convenience, and a mail failure never withholds the link.',
  })
  @IsOptional()
  @IsBoolean()
  send?: boolean;
}

export class InviteDeliveryDto {
  @ApiProperty()
  sent: boolean;

  @ApiPropertyOptional({
    description:
      'Why it did not go: `not_requested`, `not_configured` (no MAIL_FROM), `no_address`, ' +
      '`send_failed`. Always accompanied by a usable link.',
  })
  reason?: string;
}

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

  @ApiPropertyOptional({
    type: InviteDeliveryDto,
    description:
      'What became of the email, when one was asked for. Reported rather than thrown: the link ' +
      'above works pasted into a chat window, so losing it to a mailer problem would be worse.',
  })
  delivery?: InviteDeliveryDto;
}
