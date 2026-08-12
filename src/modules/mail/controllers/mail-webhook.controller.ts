import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../../auth/decorators/public.decorator';
import {
  MailWebhookService,
  type WebhookProvider,
  type WebhookResult,
} from '../services/mail-webhook.service';

const PROVIDERS = new Set<WebhookProvider>(['brevo', 'zeptomail']);

/**
 * Where pushed delivery outcomes land.
 *
 * Public, because a provider cannot authenticate as a Flui user — and therefore
 * verified inside, per connection, against the secret registered with that
 * provider. It is deliberately its own controller rather than a route on the
 * mail controller, which sits behind `@RequireSection('mail')`: a public route
 * hidden among guarded ones is how one eventually gets guarded by accident, or
 * worse, how a guard gets loosened to accommodate it.
 */
@ApiTags('Webhooks')
@Controller('webhooks/mail')
export class MailWebhookController {
  constructor(private readonly webhooks: MailWebhookService) {}

  /**
   * Proof that this endpoint is reachable from outside, and that what answers
   * is Flui.
   *
   * Registering a webhook at a URL nobody answers is the worst outcome
   * available: the provider accepts it, the console reports a webhook, and no
   * event ever arrives. A tunnel that is not running, a base URL left over from
   * another environment and a proxy serving its own page all look identical
   * from here — so the check asks for a marker rather than for a status code.
   *
   * Public and empty by design. It confirms a route exists and says nothing
   * about the install.
   */
  @Get(':provider')
  @Public()
  @ApiExcludeEndpoint()
  reachable(@Param('provider') provider: string): {
    flui: 'mail-webhook';
    provider: string;
  } {
    if (!PROVIDERS.has(provider as WebhookProvider)) {
      throw new BadRequestException(`No mail webhook for ${provider}`);
    }
    return { flui: 'mail-webhook', provider };
  }

  @Post(':provider')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async receive(
    @Param('provider') provider: string,
    @Headers() headers: Record<string, string | undefined>,
    @Req() req: RawBodyRequest<Request>,
    @Body() body: unknown,
  ): Promise<WebhookResult> {
    if (!PROVIDERS.has(provider as WebhookProvider)) {
      throw new BadRequestException(`No mail webhook for ${provider}`);
    }

    // The signature covers the bytes that arrived. `rawBody` is enabled at
    // bootstrap precisely for this; re-serialising the parsed body produces a
    // different string and a permanent mismatch.
    const raw = req.rawBody?.toString('utf8') ?? '';

    return this.webhooks.handle(
      provider as WebhookProvider,
      headers,
      raw,
      body,
    );
  }
}
