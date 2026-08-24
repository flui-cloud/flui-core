import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Request,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { MailTestService } from '../services/mail-test.service';
import { MailOnboardingService } from '../services/mail-onboarding.service';
import { MailSetupService } from '../services/mail-setup.service';
import { MailWebhookRegistrarService } from '../services/mail-webhook-registrar.service';
import { MailConnectionEntity } from '../entities/mail-connection.entity';
import {
  MailRegisterDomainDto,
  MailTestRequestDto,
  MailTestResultDto,
} from '../dto/mail-overview.dto';
import {
  ConnectMailProviderDto,
  MailConnectResultDto,
  MailConnectionDto,
  MailConnectionSetupDto,
  MailConnectionTestDraftDto,
  MailWebhookResultDto,
} from '../dto/mail-connection.dto';
import { toMailHttpError } from '../utils/mail-error.util';
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { RequireSection } from '../../iam/decorators/require-section.decorator';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';

@ApiTags('Mail')
@Controller('mail/connections')
@ApiBearerAuth()
// Recipient addresses are other people's personal data, so the whole surface is
// gated rather than only the writes.
@RequireSection('mail')
export class MailConnectionsController {
  constructor(
    private readonly testService: MailTestService,
    private readonly onboarding: MailOnboardingService,
    private readonly setup: MailSetupService,
    private readonly webhooks: MailWebhookRegistrarService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Every configured sender, and which one of each scope is sending',
    description:
      'Several providers per scope may be configured; one at a time carries the mail, marked ' +
      'by `isActive`. Two active at once — one bulk, one transactional — is the healthy state ' +
      'rather than an edge case: they must not share an account, because a suspension caused ' +
      'by a mailing list would stop password resets too. Credentials are never returned.',
  })
  @ApiResponse({ status: 200, type: [MailConnectionDto] })
  async connections(): Promise<MailConnectionDto[]> {
    const rows = await this.setup.connectionsFor();
    return rows.map(toConnectionDto);
  }

  @Post()
  @ApiOperation({
    summary: 'Connect a provider, and set everything up that can be set up',
    description:
      'Idempotent. Stores the credential, registers the sending domain with the provider, ' +
      'writes the DNS records into the zone when Flui holds it, asks the provider to verify, ' +
      'and registers the delivery-event webhook. Whatever could not be automated comes back ' +
      'in `manualSteps` rather than failing the call — a credential that works is worth ' +
      'keeping even when a DMARC record could not be written.',
  })
  @ApiResponse({ status: 201, type: MailConnectResultDto })
  @ApiResponse({
    status: 400,
    description: 'Missing credential, or the scope separation was violated',
  })
  async connect(
    @Body() dto: ConnectMailProviderDto,
  ): Promise<MailConnectResultDto> {
    return this.onboarding.connect({
      provider: dto.provider,
      scope: dto.scope,
      ...(dto.label ? { label: dto.label } : {}),
      ...(dto.sendingDomain ? { sendingDomain: dto.sendingDomain } : {}),
      ...(dto.secret ? { secret: dto.secret } : {}),
      ...(dto.config ? { config: dto.config } : {}),
      ...(dto.activate === undefined ? {} : { activate: dto.activate }),
    }) as Promise<MailConnectResultDto>;
  }

  @Post(':id/activate')
  @ApiOperation({
    summary: 'Make this the provider that carries its scope',
    description:
      'Whatever held the scope stops sending and keeps its credential, so switching back is ' +
      'the same call the other way. The separation between bulk and transactional is checked ' +
      'again here, because the other scope may have changed since this one was stored.',
  })
  @ApiResponse({ status: 200, type: MailConnectionDto })
  @ApiResponse({
    status: 400,
    description: 'The scope separation would be violated',
  })
  async activate(@Param('id') id: string): Promise<MailConnectionDto> {
    return toConnectionDto(await this.onboarding.activate(id));
  }

  @Get(':id/setup')
  @ApiOperation({
    summary: 'What this provider still wants before it will send',
    description:
      'Asked of the provider, per connection, and safe to poll: a domain is authenticated ' +
      'minutes to hours after its records go in, so the answer that matters is the one now. ' +
      'Until it is, messages are accepted over the API and refused afterwards — a failure that ' +
      'reads as nothing happening.',
  })
  @ApiResponse({ status: 200, type: MailConnectionSetupDto })
  async connectionSetup(
    @Param('id') id: string,
  ): Promise<MailConnectionSetupDto> {
    return (await this.setup.setupOf(id)) as MailConnectionSetupDto;
  }

  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Write this provider’s records into the zone',
    description:
      'For a zone Flui holds, which is the normal case — the records go in exactly as the ' +
      'provider spelled them, rather than being copied out for someone to retype. Idempotent: ' +
      'every write is an upsert, so this is also the remedy for a first attempt that landed ' +
      'wrong. A zone Flui does not hold comes back with the records still outstanding.',
  })
  @ApiResponse({
    status: 200,
    description: 'What was published, and what is still outstanding',
  })
  @ApiResponse({
    status: 412,
    description: 'The connection has no sending domain',
  })
  @ApiBody({ type: MailRegisterDomainDto, required: false })
  async publishFor(
    @Param('id') id: string,
    @Body() body?: MailRegisterDomainDto,
  ): Promise<unknown> {
    return this.onboarding.publishFor(id, body?.domain);
  }

  @Get(':id/test')
  @ApiOperation({
    summary: 'The message this provider would send, before it sends it',
    description:
      'The same probe the Domains tab offers, aimed at one connection instead of at whichever ' +
      'provider holds transactional. That is the only way to prove a bulk sender, or one that ' +
      'is configured and waiting — which is the whole reason to have it waiting.',
  })
  @ApiResponse({ status: 200, type: MailConnectionTestDraftDto })
  @ApiResponse({
    status: 412,
    description: 'The connection has no verified sending domain',
  })
  async connectionDraft(
    @Param('id') id: string,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<MailConnectionTestDraftDto> {
    const { domain } = await this.setup.testTargetFor(id);
    return { domain, ...this.testService.draft(domain, req.user?.email) };
  }

  @Post(':id/test')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send the probe through this provider specifically',
    description:
      'Goes through the connection named in the path, sending or not, at its own scope — a ' +
      'bulk sender is probed as bulk. Same two kinds as the per-domain test: `delivery` to an ' +
      'address you can open, `bounce` to a subdomain of your own domain that deliberately does ' +
      'not exist.',
  })
  @ApiResponse({ status: 200, type: MailTestResultDto })
  async connectionTest(
    @Param('id') id: string,
    @Body() dto: MailTestRequestDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<MailTestResultDto> {
    try {
      const { domain, target } = await this.setup.testTargetFor(id);
      return await this.testService.run(
        domain,
        dto.kind ?? 'delivery',
        {
          to: dto.to ?? req.user?.email,
          ...(dto.subject ? { subject: dto.subject } : {}),
          ...(dto.text !== undefined ? { text: dto.text } : {}),
        },
        target,
      );
    } catch (error) {
      throw toMailHttpError(error);
    }
  }

  @Post(':id/webhook')
  @ApiOperation({
    summary: 'Ask the provider again to deliver events here',
    description:
      'For when the reason it failed was outside the provider — most often no public URL for ' +
      'it to call. Nothing about the credential changed, so nothing has to be pasted again.',
  })
  @ApiResponse({ status: 200, type: MailWebhookResultDto })
  async retryWebhook(@Param('id') id: string): Promise<MailWebhookResultDto> {
    return (await this.webhooks.retryWebhook(id)) as MailWebhookResultDto;
  }

  @Delete(':id')
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Disconnect a provider',
    description:
      'Polls once more before the credential is destroyed, for providers whose outcomes ' +
      'arrive that way: a message sent a minute ago bounces in a few more, and losing that ' +
      'verdict means the dead address is never suppressed.',
  })
  @ApiResponse({ status: 204, description: 'Disconnected' })
  async disconnect(@Param('id') id: string): Promise<void> {
    await this.onboarding.disconnect(id);
  }
}

/** Never the secret, never the webhook token, never the fingerprint. */
function toConnectionDto(
  row: MailConnectionEntity & { implicit?: boolean },
): MailConnectionDto {
  const shared = row.credentialSource === 'scaleway-compute';
  return {
    id: row.id,
    provider: row.provider,
    scope: row.scope,
    label: row.label,
    sendingDomain: row.sendingDomain,
    isActive: row.isActive,
    hasCredential: shared || row.encryptedSecret !== null,
    webhookRegistered: Boolean(row.config?.webhookId),
    // Only while there is no webhook: a note left over from a failed attempt
    // that has since succeeded would contradict the flag beside it.
    ...(!row.config?.webhookId && row.config?.webhookNote
      ? { webhookNote: row.config.webhookNote }
      : {}),
    ...(row.config?.webhookUrl ? { webhookUrl: row.config.webhookUrl } : {}),
    implicit: row.implicit === true,
    ...(shared
      ? {
          credentialNote:
            'Uses the Scaleway key already connected for compute — Transactional Email rides ' +
            'on the same key, so there is nothing extra to store.',
        }
      : {}),
    createdAt: row.createdAt?.toISOString() ?? null,
  };
}
