import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import type {
  MailConnectionProvider,
  MailConnectionScope,
} from '../entities/mail-connection.entity';

const PROVIDERS: MailConnectionProvider[] = [
  'scaleway-tem',
  'brevo',
  'zeptomail',
  'smtp',
];
const SCOPES: MailConnectionScope[] = ['transactional', 'bulk'];

export class MailConnectionConfigDto {
  @ApiPropertyOptional({
    description:
      'ZeptoMail only, and required there. The regional API host IS the data residency — ' +
      'api.zeptomail.eu is not a mirror of api.zeptomail.com, so it is never defaulted.',
    example: 'api.zeptomail.eu',
  })
  @IsOptional()
  @IsString()
  region?: string;

  @ApiPropertyOptional({
    description: 'SMTP relay host',
    example: 'smtp.eu.mailgun.org',
  })
  @IsOptional()
  @IsString()
  host?: string;

  @ApiPropertyOptional({ description: 'SMTP relay port', example: 587 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @ApiPropertyOptional({ description: 'SMTP username' })
  @IsOptional()
  @IsString()
  username?: string;

  @ApiPropertyOptional({
    description:
      'Implicit TLS. Defaults to true on 465; 587 is upgraded with STARTTLS.',
  })
  @IsOptional()
  @IsBoolean()
  secure?: boolean;

  @ApiPropertyOptional({
    description:
      'Whether this relay may carry one-to-many mail. Declared by you, never deduced: the ' +
      'same code reaches a relay that welcomes newsletters and one whose terms forbid them.',
  })
  @IsOptional()
  @IsBoolean()
  allowsBulk?: boolean;

  @ApiPropertyOptional({
    description:
      'The bare hostname from the relay setup page — spf.mailgun.org, not the whole record.',
  })
  @IsOptional()
  @IsString()
  spfInclude?: string;

  @ApiPropertyOptional({
    description:
      'The selector the relay issued, verbatim. A key published under an invented selector ' +
      'never verifies and looks perfectly correct while failing.',
  })
  @IsOptional()
  @IsString()
  dkimSelector?: string;

  @ApiPropertyOptional({
    description: 'The DKIM record value the relay issued, verbatim.',
  })
  @IsOptional()
  @IsString()
  dkimValue?: string;
}

export class ConnectMailProviderDto {
  @ApiProperty({ enum: PROVIDERS })
  @IsIn(PROVIDERS)
  provider: MailConnectionProvider;

  @ApiProperty({
    enum: SCOPES,
    description:
      'What this sender carries. One provider per scope, and never the same account for ' +
      'both — a suspension caused by a mailing list would take password resets with it.',
  })
  @IsIn(SCOPES)
  scope: MailConnectionScope;

  @ApiPropertyOptional({
    description: 'What you call it. Never used to resolve anything.',
  })
  @IsOptional()
  @IsString()
  label?: string;

  @ApiPropertyOptional({
    description:
      'The domain to send from. Given one, Flui registers it with the provider and publishes ' +
      'the records it asks for.',
    example: 'mail.example.com',
  })
  @IsOptional()
  @IsString()
  sendingDomain?: string;

  @ApiPropertyOptional({
    description:
      'The API key or relay password. Not needed for Scaleway, which reuses the compute key ' +
      'already connected. Stored encrypted and never returned.',
  })
  @IsOptional()
  @IsString()
  secret?: string;

  @ApiPropertyOptional({ type: MailConnectionConfigDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => MailConnectionConfigDto)
  config?: MailConnectionConfigDto;

  @ApiPropertyOptional({
    description:
      'Start sending through this one immediately. Left out, a provider is stored but only ' +
      'takes the scope if nothing else holds it — adding a second provider to try it out ' +
      'must not move live password resets onto a domain that has not finished verifying.',
  })
  @IsOptional()
  @IsBoolean()
  activate?: boolean;
}

export class MailConnectionDto {
  @ApiProperty() id: string;
  @ApiProperty({ enum: PROVIDERS }) provider: string;
  @ApiProperty({ enum: SCOPES }) scope: string;
  @ApiProperty() label: string;
  @ApiProperty({ nullable: true }) sendingDomain: string | null;
  @ApiProperty() isActive: boolean;

  @ApiProperty({
    description:
      'Whether a credential is held. The credential itself never leaves.',
  })
  hasCredential: boolean;

  @ApiProperty({
    description: 'Whether the provider is pushing delivery events here.',
  })
  webhookRegistered: boolean;

  @ApiPropertyOptional({
    description:
      'Why there is no webhook, recorded when the attempt was made. Absent when there is one, ' +
      'or when this provider does not push events at all.',
  })
  webhookNote?: string;

  @ApiPropertyOptional({
    description: 'Where the provider was told to deliver events.',
  })
  webhookUrl?: string;

  /**
   * True for a sender that works without ever having been configured here.
   *
   * Only Scaleway: Transactional Email rides on the compute key already
   * connected, so it sends whether or not this table has a row for it. It is
   * flagged rather than presented as an ordinary connection because there is
   * nothing to disconnect, no credential of its own, and no sending domain Flui
   * has recorded — and reporting "nothing connected" about a provider that is
   * at that moment delivering password resets would be the worst thing this
   * endpoint could say.
   */
  @ApiProperty({
    description:
      'Active without configuration, on credentials connected elsewhere.',
  })
  implicit: boolean;

  @ApiPropertyOptional({
    description: 'Where the credential comes from, when it is not its own.',
  })
  credentialNote?: string;

  @ApiProperty({ nullable: true }) createdAt: string | null;
}

export class MailObservabilityDto {
  @ApiProperty({
    enum: ['none', 'poll', 'webhook'],
    description:
      'How outcomes arrive, which decides what the host has to wire up.',
  })
  channel: string;

  @ApiProperty({
    type: [String],
    description:
      'The outcomes that can ever be known for this provider. A kind that is absent never ' +
      'arrives — the console drops the metric rather than showing it as zero.',
  })
  reports: string[];

  @ApiPropertyOptional({
    type: [String],
    description:
      'Kinds that arrive but not all of them. A rate over these would read as measured.',
  })
  partial?: string[];

  @ApiPropertyOptional({
    description: 'One sentence naming the gap, shown verbatim.',
  })
  limitation?: string;
}

export class MailConnectionTestMessageDto {
  @ApiProperty() from: string;
  @ApiProperty() to: string;
  @ApiProperty() subject: string;
  @ApiProperty() text: string;
}

export class MailConnectionTestDraftDto {
  @ApiProperty({
    description:
      'The domain the probe will come from. Returned because the caller does not choose it — ' +
      "it is the connection's own sending domain, or the one the provider says it has verified.",
  })
  domain: string;

  @ApiProperty({ type: MailConnectionTestMessageDto })
  delivery: MailConnectionTestMessageDto;
  @ApiProperty({ type: MailConnectionTestMessageDto })
  bounce: MailConnectionTestMessageDto;
}

export class MailConnectionSetupDto {
  @ApiProperty({
    nullable: true,
    description: 'The domain being set up, if one is recorded.',
  })
  domain: string | null;

  @ApiProperty({
    nullable: true,
    description:
      "The provider's own account of what is still missing, as ordered steps. Null when this " +
      'provider offers no structured readiness — a courtesy, not a contract.',
  })
  readiness: unknown;

  @ApiProperty({
    description:
      'What the provider asks to be published. Returned whether or not Flui wrote them, ' +
      'because a record it could not write is the one worth showing.',
  })
  records: unknown;

  @ApiProperty({
    description:
      'Whether the provider will authenticate mail from this domain. Until it does, messages ' +
      'are refused — accepted over the API and rejected afterwards, which looks like silence.',
  })
  verified: boolean;
}

export class MailWebhookResultDto {
  @ApiProperty() registered: boolean;
  @ApiPropertyOptional() url?: string;

  @ApiPropertyOptional({
    description: 'Why not, in the words shown on the console.',
  })
  reason?: string;
}

export class MailConnectResultDto {
  @ApiProperty({ type: MailConnectionDto }) connection: unknown;

  @ApiProperty({
    description:
      'Whether this connection is now the one sending. False when the scope already had a ' +
      'provider and takeover was not asked for — it is stored, ready to be switched to.',
  })
  activated: boolean;
  @ApiProperty({ type: MailObservabilityDto }) observability: unknown;
  @ApiProperty({
    nullable: true,
    description: 'What was published, and what is still outstanding.',
  })
  domain: unknown;
  @ApiProperty({ description: 'Whether the delivery-event webhook is live.' })
  webhook: unknown;
  @ApiProperty({ nullable: true }) readiness: unknown;

  @ApiProperty({
    type: [String],
    description:
      'Everything a person still has to do, in the order it blocks the rest.',
  })
  manualSteps: string[];
}
