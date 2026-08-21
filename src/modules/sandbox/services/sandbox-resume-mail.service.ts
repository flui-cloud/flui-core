import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MailSendService } from '../../mail/services/mail-send.service';

export interface ResumeMailInput {
  to: string;
  resumeLink: string;
  /** Shown so the message can say how long the link is worth keeping. */
  hoursLeft: number;
}

export interface ResumeMailOutcome {
  sent: boolean;
  /** Machine-readable when it did not go: `not_configured`, `send_failed`. */
  reason?: string;
}

/**
 * Mailing a guest the way back into their own sandbox.
 *
 * The address is asked for *inside* the product, after the visitor has seen what
 * they get — a form on the entrance works against the single reason the demo
 * exists. So this is the only place the sandbox has an address at all, and it is
 * used for one thing.
 *
 * Reported rather than thrown, like every other send here: failing to mail must
 * not look like failing to save. The tenancy is unaffected either way — the
 * browser that asked is still signed into it.
 */
@Injectable()
export class SandboxResumeMailService {
  private readonly logger = new Logger(SandboxResumeMailService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly sender: MailSendService,
  ) {}

  configured(): boolean {
    return Boolean(this.config.get<string>('MAIL_FROM'));
  }

  async sendResumeLink(input: ResumeMailInput): Promise<ResumeMailOutcome> {
    const from = this.config.get<string>('MAIL_FROM');
    if (!from) return { sent: false, reason: 'not_configured' };

    const product = this.config.get<string>('MAIL_FROM_NAME') ?? 'Flui';
    const window =
      input.hoursLeft <= 1
        ? 'less than an hour'
        : `about ${Math.round(input.hoursLeft)} hours`;

    try {
      await this.sender.send({
        from: { email: from, name: product },
        to: [{ email: input.to }],
        subject: `Your ${product} sandbox`,
        text:
          `Here is the way back into the sandbox you opened:\n\n` +
          `${input.resumeLink}\n\n` +
          `It works from any device, and it stops working when the sandbox is ` +
          `deleted — in ${window}. Everything in it goes with it.\n\n` +
          `If you did not ask for this, you can ignore this message.\n`,
        // One message, triggered by one person, to the address that person just
        // typed. That is what transactional means, and it is what keeps this on
        // a provider whose terms forbid anything else.
        scope: 'transactional',
      });
      return { sent: true };
    } catch (error) {
      this.logger.warn(
        `Could not mail a sandbox resume link: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { sent: false, reason: 'send_failed' };
    }
  }
}
