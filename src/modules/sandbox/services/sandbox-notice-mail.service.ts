import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MailSendService } from '../../mail/services/mail-send.service';

/**
 * The two messages a demo guest receives: their applications are about to
 * go, and a space they waited for is theirs. Reported rather than thrown:
 * failing to mail must never stop the sweep that sends it.
 */
@Injectable()
export class SandboxNoticeMailService {
  private readonly logger = new Logger(SandboxNoticeMailService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly sender: MailSendService,
  ) {}

  async expiryWarning(input: {
    to: string;
    apps: string[];
    hoursLeft: number;
    dashboardUrl: string;
  }): Promise<boolean> {
    const window =
      input.hoursLeft <= 1
        ? 'less than an hour'
        : `about ${Math.round(input.hoursLeft)} hours`;
    return this.send(
      input.to,
      'Your demo applications are about to be removed',
      `${input.apps.join(', ')} will be removed in ${window}.\n\n` +
        `To keep them longer, open your space and press "Keep my apps", or ` +
        `deploy something:\n\n${input.dashboardUrl}\n\n` +
        `If you are done with them, there is nothing to do.\n`,
    );
  }

  async waitlistOffer(input: {
    to: string;
    hours: number;
    dashboardUrl: string;
  }): Promise<boolean> {
    return this.send(
      input.to,
      'A demo space is free for you',
      `A space in the demo is free and kept for you for ${input.hours} hours. ` +
        `Deploy something to take it:\n\n${input.dashboardUrl}\n\n` +
        `After that it goes to the next person waiting.\n`,
    );
  }

  private async send(
    to: string,
    subject: string,
    text: string,
  ): Promise<boolean> {
    const from = this.config.get<string>('MAIL_FROM');
    if (!from) return false;
    const product = this.config.get<string>('MAIL_FROM_NAME') ?? 'Flui';
    try {
      await this.sender.send({
        from: { email: from, name: product },
        to: [{ email: to }],
        subject,
        text,
        scope: 'transactional',
      });
      return true;
    } catch (error) {
      this.logger.warn(
        `Could not mail a demo notice: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }
}
