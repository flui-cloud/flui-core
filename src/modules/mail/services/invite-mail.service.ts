import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MailSendService } from './mail-send.service';

export interface InviteMailInput {
  to: string;
  inviteLink: string;
  /** Used to address the message. Absent is fine — no filler name is invented. */
  firstName?: string;
  /** Who is asking. Shown so the recipient can tell an invitation from a phish. */
  invitedBy?: string;
}

export interface InviteMailOutcome {
  sent: boolean;
  /** Machine-readable when it did not go: `not_configured`, `send_failed`. */
  reason?: string;
  messageId?: string | null;
}

/**
 * Delivering an invite link instead of asking an admin to copy it.
 *
 * Deliberately best-effort and reported rather than thrown. The link is
 * generated whether or not this succeeds, and it works when pasted into a chat
 * window — so a mail failure must degrade to "here is the link, send it
 * yourself" rather than fail the invitation. Losing the link because the
 * mailer was misconfigured would be strictly worse than never having tried.
 *
 * `MAIL_FROM` gates the whole thing. Unset means "email is not set up here",
 * which is the honest default for a platform that has only just gained the
 * ability to send: guessing a sender on a domain the provider has not verified
 * produces mail that is silently discarded, which looks exactly like success.
 */
@Injectable()
export class InviteMailService {
  private readonly logger = new Logger(InviteMailService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly sender: MailSendService,
  ) {}

  configured(): boolean {
    return Boolean(this.config.get<string>('MAIL_FROM'));
  }

  async sendInvite(input: InviteMailInput): Promise<InviteMailOutcome> {
    const from = this.config.get<string>('MAIL_FROM');
    if (!from) return { sent: false, reason: 'not_configured' };

    const greeting = input.firstName ? `Hi ${input.firstName},` : 'Hi,';
    const who = input.invitedBy ? ` by ${input.invitedBy}` : '';
    const product = this.config.get<string>('MAIL_FROM_NAME') ?? 'Flui';

    try {
      const result = await this.sender.send({
        from: { email: from, name: product },
        to: [{ email: input.to }],
        subject: `You have been invited to ${product}`,
        text:
          `${greeting}\n\n` +
          `You have been invited${who} to ${product}. Open the link below to set your ` +
          `password and finish setting up your account:\n\n` +
          `${input.inviteLink}\n\n` +
          `If you were not expecting this, you can ignore this message.\n`,
        // An invitation is triggered by one administrator's action for one
        // person, which is what transactional means — and it is what keeps this
        // on a provider whose terms forbid anything else.
        scope: 'transactional',
        reference: 'invite',
      });
      this.logger.log(`Invite sent to ${input.to}`);
      return { sent: true, messageId: result.messageId };
    } catch (error) {
      this.logger.warn(`Could not email the invite to ${input.to}: ${error}`);
      return { sent: false, reason: 'send_failed' };
    }
  }
}
