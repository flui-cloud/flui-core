import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { MailSendService } from './mail-send.service';
import { IdentityEmailSetupService } from './identity-email-setup.service';
import {
  IdentityEmailDedupeService,
  identityBodyHash,
} from './identity-email-dedupe.service';
import {
  IdentityEmailPayloadError,
  parseIdentityEmail,
} from '../utils/identity-email-message.util';
import { verifyIdentitySignature } from '../utils/identity-email-signature.util';
import { describeError } from '../utils/mail-error.util';

export const IDENTITY_MAIL_CATEGORY = 'identity';

export type IdentityEmailReceipt =
  | { sent: true; provider: string; messageId: string | null }
  | { sent: false; duplicate: true };

/**
 * One message from the identity provider, verified and sent through the
 * transactional sender. Anything short of a send answers non-2xx, so the
 * identity provider records the failure and retries. Bodies carry sign-in
 * codes, so nothing from the message is logged.
 */
@Injectable()
export class IdentityEmailService {
  private readonly logger = new Logger(IdentityEmailService.name);

  constructor(
    private readonly setup: IdentityEmailSetupService,
    private readonly sender: MailSendService,
    private readonly dedupe: IdentityEmailDedupeService,
  ) {}

  async receive(
    signature: string | undefined,
    raw: string | Buffer,
    body: unknown,
    now: number = Date.now(),
  ): Promise<IdentityEmailReceipt> {
    const key = await this.setup.signingKey();
    if (!key) {
      throw new ServiceUnavailableException(
        'Flui holds no signing key for the identity provider yet.',
      );
    }
    const verdict = verifyIdentitySignature(signature, raw, key, now);
    if (verdict !== 'valid') {
      this.logger.warn(`[mail] identity email refused: signature ${verdict}`);
      throw new UnauthorizedException(`Signature ${verdict}.`);
    }

    let message;
    try {
      message = parseIdentityEmail(body);
    } catch (error) {
      if (error instanceof IdentityEmailPayloadError) {
        await this.setup.recordFailure(error.message);
        throw new BadRequestException(error.message);
      }
      throw error;
    }

    const from = await this.setup.sender();
    if ('reason' in from) {
      await this.setup.recordFailure(
        'No transactional sender is ready.',
        from.reason,
      );
      throw new ServiceUnavailableException(
        `Sign-in mail cannot be sent: ${from.reason}.`,
      );
    }

    const hash = identityBodyHash(raw, key);
    const claim = await this.dedupe.claim(hash, new Date(now));
    if (claim === 'duplicate') {
      this.logger.log(
        `[mail] identity email ${message.eventType ?? 'message'} already sent, retry not sent again`,
      );
      return { sent: false, duplicate: true };
    }
    if (claim === 'in_flight') {
      throw new ConflictException(
        'This message is being sent right now. Try again shortly.',
      );
    }

    try {
      const result = await this.sender.send(
        {
          from: { email: from.email, name: from.name },
          to: [{ email: message.to }],
          subject: message.subject,
          text: message.text,
          html: message.html,
          scope: 'transactional',
          reference: IDENTITY_MAIL_CATEGORY,
        },
        undefined,
        { category: IDENTITY_MAIL_CATEGORY },
      );
      await this.dedupe.sent(hash);
      await this.setup.recordDelivery();
      this.logger.log(
        `[mail] identity email ${message.eventType ?? 'message'} handed to ${result.provider}`,
      );
      return {
        sent: true,
        provider: result.provider,
        messageId: result.messageId,
      };
    } catch (error) {
      await this.dedupe.release(hash).catch(() => undefined);
      const detail =
        error instanceof HttpException ? error.message : describeError(error);
      await this.setup.recordFailure(detail);
      this.logger.warn(`[mail] identity email not sent: ${detail}`);
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException('Sign-in mail could not be sent.');
    }
  }
}
