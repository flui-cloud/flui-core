import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * The console's read model.
 *
 * Shapes mirror `@flui-cloud/mail`'s console contract exactly — these classes
 * exist to describe it to Swagger, not to restate it. The rules that produce
 * the numbers live in the package, so the standalone console and this one
 * cannot drift apart on what a bounce rate means.
 */

export class MailKpiDto {
  @ApiProperty({ enum: ['sent', 'delivered', 'bounced', 'complained'] })
  id: string;

  @ApiProperty()
  count: number;

  @ApiProperty({
    nullable: true,
    description:
      'Share of all messages in the window, 0..1. Null for `sent`, the denominator.',
  })
  rate: number | null;

  @ApiProperty()
  previousCount: number;

  @ApiProperty({ nullable: true })
  previousRate: number | null;

  @ApiProperty({
    nullable: true,
    description:
      'Change against the preceding window: the difference of the two rates for a rate KPI, ' +
      'relative change for `sent`. Null when the baseline held nothing — a fresh install has ' +
      'no history, and reporting that as +100% invents a trend out of an empty table.',
  })
  delta: number | null;

  @ApiProperty({
    enum: ['neutral', 'warn', 'bad'],
    description:
      "Complaint thresholds are Google's published ones (0.10% target, 0.30% ceiling). " +
      'Bounce thresholds are ours and advisory — Google publishes none.',
  })
  tone: string;
}

export class MailVolumePointDto {
  @ApiProperty({
    description: 'Bucket start, UTC. Hourly over 24h, daily otherwise.',
  })
  at: string;

  @ApiProperty()
  delivered: number;

  @ApiProperty()
  failed: number;

  @ApiProperty({
    description:
      'Accepted, no verdict yet. Separate so the bar adds up honestly.',
  })
  pending: number;
}

export class MailDomainSummaryDto {
  @ApiProperty()
  domain: string;

  @ApiProperty({ enum: ['ok', 'missing', 'mismatch'] })
  spf: string;

  @ApiProperty({ enum: ['ok', 'missing', 'mismatch'] })
  dkim: string;

  @ApiProperty({ enum: ['ok', 'missing', 'mismatch'] })
  dmarc: string;

  @ApiProperty({
    description:
      "The provider's own verification, which is not what DNS says. Records can be correct and " +
      'published while the provider has not re-checked them yet.',
  })
  verified: boolean;

  @ApiProperty()
  sent: number;
}

export class MailIdentityDto {
  @ApiProperty()
  applicationId: string;

  @ApiProperty()
  applicationName: string;

  @ApiProperty()
  address: string;
}

export class MailSenderSummaryDto {
  @ApiProperty({
    description:
      'The envelope sender — the axis this screen is organised around.',
  })
  from: string;

  @ApiProperty()
  domain: string;

  @ApiProperty({
    type: MailIdentityDto,
    nullable: true,
    description:
      'Set once Flui knows which application holds this address. Null means the row is an ' +
      'address rather than an application, and says so.',
  })
  application: MailIdentityDto | null;

  @ApiProperty()
  sent: number;

  @ApiProperty()
  delivered: number;

  @ApiProperty()
  failed: number;

  @ApiProperty({ nullable: true })
  deliveredRate: number | null;

  @ApiProperty({
    nullable: true,
    description: "The receiving server's own words. Never paraphrased.",
  })
  lastError: string | null;

  @ApiProperty({ nullable: true })
  lastErrorAt: string | null;

  @ApiProperty({ nullable: true })
  lastSentAt: string | null;

  @ApiProperty({ nullable: true })
  lastDeliveredAt: string | null;

  @ApiProperty({
    enum: ['delivering', 'degraded', 'failing', 'silent'],
    description:
      '`silent` is an application handed a sending identity that has used it for nothing — the ' +
      'state no provider dashboard can report, because the provider only knows mail that exists.',
  })
  status: string;
}

export class MailIncidentDto {
  @ApiProperty({ enum: ['sender-down', 'domain-broken', 'complaint-rate'] })
  kind: string;

  @ApiProperty()
  title: string;

  @ApiProperty()
  detail: string;

  @ApiProperty()
  subject: string;

  @ApiProperty({ nullable: true })
  since: string | null;
}

export class MailWindowDto {
  @ApiProperty()
  from: string;

  @ApiProperty()
  to: string;

  @ApiProperty({ enum: ['24h', '7d', '14d', '30d'] })
  name: string;
}

export class MailOverviewDto {
  @ApiProperty({ nullable: true })
  provider: string | null;

  @ApiProperty({ type: MailWindowDto })
  window: MailWindowDto;

  @ApiProperty({ enum: ['hour', 'day'] })
  bucket: string;

  @ApiProperty({
    type: MailIncidentDto,
    nullable: true,
    description:
      'The one thing to say first, or nothing. Singular on purpose: a banner listing five ' +
      'problems reads as a backlog rather than as something happening now.',
  })
  incident: MailIncidentDto | null;

  @ApiProperty({ type: [MailKpiDto] })
  kpis: MailKpiDto[];

  @ApiProperty({ type: [MailVolumePointDto] })
  volume: MailVolumePointDto[];

  @ApiProperty({ type: [MailDomainSummaryDto] })
  domains: MailDomainSummaryDto[];

  @ApiProperty({ type: [MailSenderSummaryDto] })
  senders: MailSenderSummaryDto[];

  @ApiProperty({
    type: [String],
    description:
      'Domains that sent mail in the window and for which no proofs are held. Listed rather ' +
      'than shown as broken records: nobody checked them.',
  })
  unregisteredDomains: string[];
}

export class MailRegisterDomainDto {
  @ApiPropertyOptional({
    description:
      'A domain to register with this connection’s provider. Omitted, the connection’s own ' +
      'sending domain is re-published. Registering a second domain does not move the mail onto ' +
      'it — the connection keeps whatever it was already sending from.',
    example: 'news.example.com',
  })
  domain?: string;
}

const VERDICTS = ['ok', 'missing', 'mismatch', 'pending'];

export class MailDomainProofsDto {
  @ApiProperty()
  domain: string;

  @ApiPropertyOptional({
    enum: VERDICTS,
    description:
      'Absent where this provider asks for no such record — Brevo authenticates on DKIM and ' +
      'publishes no SPF requirement at all. Distinct from `missing`, which means it asked and ' +
      'the record is not there. `pending` means the provider has not accepted the record yet, ' +
      'which is not the same as the record being absent from DNS.',
  })
  spf?: string;

  @ApiPropertyOptional({ enum: VERDICTS })
  dkim?: string;

  @ApiPropertyOptional({ enum: VERDICTS })
  dmarc?: string;

  @ApiProperty()
  verified: boolean;

  @ApiProperty({
    description:
      'Which connection holds this domain. Without it a list covering two providers cannot say ' +
      'whose account a domain lives in — and a domain only exists as one account’s ' +
      'registration, so it is not an attribute of the platform but of the connection.',
  })
  provider: string;

  @ApiProperty({ enum: ['transactional', 'bulk'] })
  scope: string;

  @ApiProperty({
    description:
      'Whether that connection is the one currently carrying its scope.',
  })
  active: boolean;

  @ApiProperty()
  connectionId: string;
}

export class MailTestRequestDto {
  @ApiPropertyOptional({
    enum: ['delivery', 'bounce'],
    default: 'delivery',
    description:
      '`delivery` sends a real message so you can look in your own inbox — the one thing a green ' +
      'readiness check does not prove. `bounce` addresses a subdomain of your own domain that ' +
      'deliberately does not exist, so the refusal travels the whole way and you can watch it ' +
      'arrive. Whether it also ends correspondence depends on how the failure classifies.',
  })
  kind?: 'delivery' | 'bounce';

  @ApiPropertyOptional({
    description:
      'Where to send the delivery test. Defaults to your own address, which is the only mailbox ' +
      'you can actually check. Exactly one — addressing people who did not trigger the message ' +
      'is what turns a test into a sending channel. Ignored by the bounce probe, whose recipient ' +
      'is fixed.',
  })
  to?: string;

  @ApiPropertyOptional({ description: 'Overrides the drafted subject.' })
  subject?: string;

  @ApiPropertyOptional({
    description: 'Overrides the drafted body. Plain text; no attachments.',
  })
  text?: string;
}

export class MailTestMessageDto {
  @ApiProperty()
  from: string;

  @ApiProperty()
  to: string;

  @ApiProperty()
  subject: string;

  @ApiProperty()
  text: string;
}

export class MailTestDraftDto {
  @ApiProperty({
    type: MailTestMessageDto,
    description:
      'Addressed to you, because that is the only mailbox you can check.',
  })
  delivery: MailTestMessageDto;

  @ApiProperty({
    type: MailTestMessageDto,
    description:
      'Fixed recipient: a subdomain of your domain that deliberately does not exist.',
  })
  bounce: MailTestMessageDto;
}

export class MailTestResultDto {
  @ApiProperty({ enum: ['delivery', 'bounce'] })
  kind: string;

  @ApiProperty()
  from: string;

  @ApiProperty()
  to: string;

  @ApiProperty()
  provider: string;

  @ApiProperty({ nullable: true })
  messageId: string | null;

  @ApiProperty()
  accepted: number;

  @ApiPropertyOptional({
    description:
      'Bounce probe only, and not a failure: the address is already suppressed from an earlier ' +
      'run, so nothing was sent — which is the proof the probe exists to produce.',
  })
  alreadySuppressed?: boolean;
}

export class MailOverviewQueryDto {
  @ApiPropertyOptional({ enum: ['24h', '7d', '14d', '30d'], default: '14d' })
  window?: string;
}
