import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class MailAddressDto {
  @ApiProperty({ example: 'noreply@example.com' })
  @IsEmail()
  email: string;

  @ApiPropertyOptional({ example: 'Example' })
  @IsOptional()
  @IsString()
  name?: string;
}

export class SendMailDto {
  @ApiProperty({
    type: MailAddressDto,
    description:
      'Must be on a domain the provider has verified for this account.',
  })
  @ValidateNested()
  @Type(() => MailAddressDto)
  from: MailAddressDto;

  @ApiProperty({ type: [MailAddressDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => MailAddressDto)
  to: MailAddressDto[];

  @ApiProperty()
  @IsString()
  subject: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  text?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  html?: string;

  @ApiPropertyOptional({
    enum: ['transactional', 'bulk'],
    default: 'transactional',
    description:
      'Providers draw the line at one-to-one triggered by a user action versus one-to-many, ' +
      'not at whether the message sells something. A driver whose terms forbid the stated ' +
      'scope refuses the message rather than discovering the rule from a suspension.',
  })
  @IsOptional()
  @IsIn(['transactional', 'bulk'])
  scope?: 'transactional' | 'bulk';

  @ApiPropertyOptional({
    description: "The caller's own correlation id. Never message content.",
  })
  @IsOptional()
  @IsString()
  reference?: string;
}

export class SendMailResultDto {
  @ApiProperty({ example: 'scaleway-tem' })
  provider: string;

  @ApiProperty({
    nullable: true,
    description: "The provider's handle for the send.",
  })
  messageId: string | null;

  @ApiProperty()
  accepted: number;
}

export class DeliveryEventDto {
  @ApiProperty({
    enum: [
      'queued',
      'sent',
      'delivered',
      'deferred',
      'bounced',
      'complained',
      'unsubscribed',
      'canceled',
    ],
  })
  kind: string;

  @ApiProperty()
  provider: string;

  @ApiProperty()
  messageId: string;

  @ApiProperty()
  recipient: string;

  @ApiPropertyOptional({
    description:
      'The envelope sender — the axis an application is recognised by.',
  })
  from?: string;

  @ApiProperty()
  at: string;

  @ApiPropertyOptional({
    description: "The provider's short reason. Never body content.",
  })
  reason?: string;

  @ApiPropertyOptional({
    description: 'SMTP status code: 5xx permanent, 4xx temporary.',
  })
  code?: number;

  @ApiPropertyOptional()
  subject?: string;
}
