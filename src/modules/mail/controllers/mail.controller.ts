import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Request,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { MailReadinessService } from '../services/mail-readiness.service';
import { MailSendService } from '../services/mail-send.service';
import { MailReadinessDto } from '../dto/mail-readiness.dto';
import {
  DeliveryEventDto,
  SendMailDto,
  SendMailResultDto,
} from '../dto/send-mail.dto';
import { SuppressionDto } from '../dto/suppression.dto';
import { MailSuppressionService } from '../services/mail-suppression.service';
import { MailOverviewService } from '../services/mail-overview.service';
import { MailEventStoreService } from '../services/mail-event-store.service';
import {
  MailDomainProofsDto,
  MailOverviewDto,
  MailTestDraftDto,
  MailTestRequestDto,
  MailTestResultDto,
} from '../dto/mail-overview.dto';
import { MailTestService } from '../services/mail-test.service';
import { MailSetupService } from '../services/mail-setup.service';
import { toMailHttpError } from '../utils/mail-error.util';
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import type { MailEventKind } from '../entities/mail-event.entity';
import type { MailWindow } from '@flui-cloud/mail';
import { RequireSection } from '../../iam/decorators/require-section.decorator';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';

const WINDOWS: MailWindow[] = ['24h', '7d', '14d', '30d'];

/** An unrecognised window falls back rather than 400s: it is a view preference, not a command. */
function asWindow(value: string | undefined): MailWindow {
  return WINDOWS.find((w) => w === value) ?? '14d';
}

@ApiTags('Mail')
@Controller('mail')
@ApiBearerAuth()
// Recipient addresses are other people's personal data, so the whole surface is
// gated rather than only the writes.
@RequireSection('mail')
// The three reads an agent reaches carry `cluster:read` on top. It takes nothing
// from anybody — the `mail` section admits only `full`, which is
// `cluster:manage` at global scope, and every role holding that holds
// `cluster:read`; a sandbox guest is answered from the example world before the
// guard runs. It is there because the credential ceiling reads
// `@RequirePermission` and `@AppAction` and nothing else, so
// until now no agent key could be scoped away from other people's addresses.
export class MailController {
  constructor(
    private readonly readiness: MailReadinessService,
    private readonly sender: MailSendService,
    private readonly suppressions: MailSuppressionService,
    private readonly overviewService: MailOverviewService,
    private readonly store: MailEventStoreService,
    private readonly testService: MailTestService,
    private readonly setup: MailSetupService,
  ) {}

  @Get('readiness')
  @RequirePermission(IAM_PERMISSION.CLUSTER_READ)
  @ApiOperation({
    summary: 'What still stands between Flui and a sent message',
    description:
      'Asks the provider that is actually carrying this scope, rather than inferring from a ' +
      'failed send. Several causes look identical from the outside — a key whose policy does ' +
      'not cover the email service, a domain registered in another account, a sender the ' +
      'provider has not validated, records still propagating — and each sends the operator ' +
      'somewhere different. Steps come back as satisfied, automatable, manual or pending.',
  })
  @ApiQuery({
    name: 'domain',
    required: false,
    description:
      'Sending domain to inspect. Omitted, only the credential is checked — which is enough to ' +
      "answer whether the connected key covers the provider's email service at all.",
  })
  @ApiQuery({
    name: 'scope',
    required: false,
    enum: ['transactional', 'bulk'],
    description: 'Which sender to ask about. Defaults to transactional.',
  })
  @ApiResponse({ status: 200, type: MailReadinessDto })
  async getReadiness(
    @Query('domain') domain?: string,
    @Query('scope') scope?: string,
  ): Promise<MailReadinessDto> {
    return this.readiness.current(
      domain,
      scope === 'bulk' ? 'bulk' : 'transactional',
    );
  }

  @Post('send')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send a message through the configured provider',
    description:
      'Returns as soon as the provider accepts the message, which is not the same as delivery. ' +
      'Poll /mail/events for the verdict: a receiver takes seconds or minutes to answer, and a ' +
      'refusal that arrives later moves the same message to bounced.',
  })
  @ApiResponse({ status: 200, type: SendMailResultDto })
  async send(@Body() dto: SendMailDto): Promise<SendMailResultDto> {
    return this.sender.send(dto);
  }

  @Get('overview')
  @ApiOperation({
    summary: 'The state of sending, in one read',
    description:
      'Incident, headline rates, volume by outcome, domain proofs and per-sender health. The ' +
      'arithmetic lives in `@flui-cloud/mail` as pure functions, so the standalone console and ' +
      'this one cannot drift apart on what a bounce rate means. Complaint thresholds are the ' +
      'ones Google publishes; bounce thresholds are ours and advisory, because Google states none.',
  })
  @ApiQuery({
    name: 'window',
    required: false,
    enum: ['24h', '7d', '14d', '30d'],
    description:
      'Defaults to 14d. The preceding window of equal length is the baseline.',
  })
  @ApiResponse({ status: 200, type: MailOverviewDto })
  async overview(@Query('window') window?: string): Promise<MailOverviewDto> {
    return this.overviewService.overview(
      asWindow(window),
    ) as unknown as MailOverviewDto;
  }

  @Get('domains')
  @ApiOperation({
    summary: 'Every sending domain, across every connected provider',
    description:
      'Separate from /mail/readiness, which answers about one domain and about the credential ' +
      'behind it. This is the set — both scopes, every connection — and each row names the ' +
      'connection holding it, because a domain is one account’s registration rather than a ' +
      'property of the platform. An empty list is a normal answer where email has not been ' +
      'set up; readiness explains why, and does it in full.',
  })
  @ApiResponse({ status: 200, type: [MailDomainProofsDto] })
  async domains(): Promise<MailDomainProofsDto[]> {
    const rows = await this.setup.domainsAcrossConnections();
    return rows as unknown as MailDomainProofsDto[];
  }

  @Get('events')
  @RequirePermission(IAM_PERMISSION.CLUSTER_READ)
  @ApiOperation({
    summary: 'Delivery outcomes reported by the provider',
    description:
      'State, not history: the same message comes back with a changed verdict as it progresses, ' +
      'so this is stored — and read — as one row per message and recipient rather than as a log. ' +
      'Served from what the poller has collected; the provider is still the source of truth, but ' +
      'reading a fortnight from it costs thousands of round trips.',
  })
  @ApiQuery({
    name: 'since',
    required: false,
    description: 'ISO timestamp. Defaults to 14 days back.',
  })
  @ApiQuery({ name: 'until', required: false, description: 'ISO timestamp.' })
  @ApiQuery({
    name: 'kind',
    required: false,
    description: 'Comma-separated outcomes, e.g. `bounced,complained`.',
  })
  @ApiQuery({
    name: 'sender',
    required: false,
    description: 'Envelope sender, exact.',
  })
  @ApiQuery({
    name: 'q',
    required: false,
    description: 'Substring of either address.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Up to 200. Defaults to 50.',
  })
  @ApiQuery({ name: 'offset', required: false })
  @ApiResponse({ status: 200, type: [DeliveryEventDto] })
  async events(
    @Query('since') since?: string,
    @Query('until') until?: string,
    @Query('kind') kind?: string,
    @Query('sender') sender?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<DeliveryEventDto[]> {
    const from = since ? new Date(since) : undefined;
    // Backfills on a host whose scheduler has never run, then reads the table.
    await this.sender.events(from);

    const page = await this.store.page({
      ...(from ? { from } : {}),
      ...(until ? { to: new Date(until) } : {}),
      ...(kind
        ? { kinds: kind.split(',').map((k) => k.trim()) as MailEventKind[] }
        : {}),
      ...(sender ? { fromAddress: sender } : {}),
      ...(q ? { search: q } : {}),
      ...(limit ? { limit: Number(limit) } : {}),
      ...(offset ? { offset: Number(offset) } : {}),
    });
    return page.events;
  }

  @Post('domains/:domain/publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Register a sending domain and publish the records it needs',
    description:
      'Idempotent: safe to call repeatedly while waiting for verification. When Flui holds the ' +
      'zone the records are written for you; when it does not, they come back under `outstanding` ' +
      "to publish wherever the zone actually lives. Verification is the provider's to give and " +
      'lags DNS by minutes — poll /mail/readiness for it.',
  })
  @ApiParam({ name: 'domain', example: 'example.com' })
  async publishDomain(@Param('domain') domain: string) {
    return this.sender.publishDomain(domain);
  }

  @Delete('domains/:domain')
  @ApiOperation({
    summary: 'Hand a sending domain back to the provider',
    description:
      'Scaleway is blunt about this: "Deleting a domain is permanent and cannot be undone", and ' +
      'the DKIM private key is destroyed with it — registering the same domain again issues a new ' +
      'key under a new selector. DNS cleanup is deliberately partial: the DKIM record is deleted ' +
      'and the Flui `include:` taken back out of the SPF, while the MX and DMARC are reported and ' +
      'left alone, because nothing recorded whether Flui created them and deleting an MX it did ' +
      'not create stops inbound mail with no error anywhere.',
  })
  @ApiParam({ name: 'domain', example: 'example.com' })
  @ApiQuery({
    name: 'cleanupDns',
    required: false,
    description:
      'Set false to revoke at the provider and leave the zone entirely untouched.',
  })
  async removeDomain(
    @Param('domain') domain: string,
    @Query('cleanupDns') cleanupDns?: string,
  ) {
    return this.sender.removeDomain(domain, {
      cleanupDns: cleanupDns !== 'false',
    });
  }

  @Get('domains/:domain/test')
  @ApiOperation({
    summary: 'The message that would be sent, before it is',
    description:
      'Sender, recipient, subject and body, so a person reads them and edits them rather than ' +
      'pressing a button and finding out afterwards where their mail went. The sender follows a ' +
      'rule — the configured MAIL_FROM only when it belongs to this domain — which is composed ' +
      'here so no client has to reimplement it.',
  })
  @ApiParam({ name: 'domain', example: 'example.com' })
  @ApiResponse({ status: 200, type: MailTestDraftDto })
  draft(
    @Param('domain') domain: string,
    @Request() req: { user: AuthenticatedUser },
  ): MailTestDraftDto {
    return this.testService.draft(domain, req.user?.email);
  }

  @Post('domains/:domain/test')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Prove the two things readiness cannot',
    description:
      'A green readiness check says the records are correct; it does not say a message arrives. ' +
      '`delivery` sends a real one to an address you can open. `bounce` addresses a subdomain of ' +
      'your own domain that deliberately does not exist, so a refusal travels the whole path — ' +
      'provider, poller, activity list — which is about this platform rather than the provider. ' +
      'Deliberately ' +
      "not a composer: sending from a verified domain carries the operator's own reputation, and " +
      "Transactional Email's terms forbid the one-to-many mail a free-form editor invites.",
  })
  @ApiParam({ name: 'domain', example: 'example.com' })
  @ApiResponse({ status: 200, type: MailTestResultDto })
  async test(
    @Param('domain') domain: string,
    @Body() dto: MailTestRequestDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<MailTestResultDto> {
    try {
      // The caller's own mailbox is the default because it is the only one they
      // can check — and the only one it is theirs to write to unprompted.
      return await this.testService.run(domain, dto.kind ?? 'delivery', {
        to: dto.to ?? req.user?.email,
        ...(dto.subject ? { subject: dto.subject } : {}),
        ...(dto.text !== undefined ? { text: dto.text } : {}),
      });
    } catch (error) {
      throw toMailHttpError(error);
    }
  }

  @Get('suppressions')
  @RequirePermission(IAM_PERMISSION.CLUSTER_READ)
  @ApiOperation({
    summary:
      'Addresses Flui has stopped writing to, and how far the stop reaches',
    description:
      'A do-not-send list nobody can read is a list nobody can trust. Every entry says why ' +
      'sending stopped, when, and whether it stops everything or only one-to-many mail.',
  })
  @ApiResponse({ status: 200, type: [SuppressionDto] })
  async listSuppressions(): Promise<SuppressionDto[]> {
    return this.suppressions.list();
  }

  @Delete('suppressions/:address')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Start writing to an address again',
    description:
      'Deliberately available: a mailbox that was full in March exists again in April, and a ' +
      "list with no way out of it eventually suppresses the operator's own address.",
  })
  @ApiParam({ name: 'address', example: 'someone@example.com' })
  @ApiResponse({ status: 204, description: 'Removed, or was not there' })
  async removeSuppression(@Param('address') address: string): Promise<void> {
    await this.suppressions.remove(address);
  }
}
