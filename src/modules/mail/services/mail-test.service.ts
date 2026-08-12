import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MailDriver, SendScope } from '@flui-cloud/mail';
import { MailSendService } from './mail-send.service';
import { MailSuppressionService } from './mail-suppression.service';

/**
 * A subdomain of the operator's own sending domain that is deliberately never
 * created — no MX, no A — so the message is accepted and then fails to route.
 *
 * The obvious choice was an RFC 2606 `.invalid` address, and Scaleway refuses
 * it outright: `invalid argument(s) … Invalid email recipient address`, a
 * *format* check that happens before anything is sent. So the probe would have
 * proved only that the provider validates input. A real-looking name under a
 * domain we control passes that check and then genuinely cannot be delivered,
 * which is the refusal we are trying to observe — and it borrows nobody else's
 * domain to do it, which is exactly what SES's mailbox simulator exists to
 * avoid. Scaleway publishes no simulator addresses.
 */
function probeAddress(domain: string): string {
  return `bounce-probe@invalid.${domain}`;
}

export type MailTestKind = 'delivery' | 'bounce';

/**
 * Which sender the probe goes through.
 *
 * Empty means the one carrying transactional mail, which is what the Domains
 * tab asks about. It is filled in when the question is about a *connection*
 * rather than a domain — a bulk provider, or one configured and not yet
 * sending. That second case is the one that matters: a provider is put on
 * standby precisely so it can be proved before it takes over the password
 * resets, and a test that silently went through the incumbent would report
 * success for the wrong account.
 */
export interface MailTestTarget {
  scope?: SendScope;
  driver?: MailDriver;
  /** Its name, for the one report produced without sending anything. */
  provider?: string;
}

export interface MailTestMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
}

export interface MailTestDraft {
  delivery: MailTestMessage;
  bounce: MailTestMessage;
}

export interface MailTestResult {
  kind: MailTestKind;
  from: string;
  to: string;
  provider: string;
  messageId: string | null;
  accepted: number;
  /**
   * Only for the bounce probe, and not a failure: the address is already on the
   * do-not-send list from a previous run, so nothing was sent — which is itself
   * the proof the probe exists to produce.
   */
  alreadySuppressed?: boolean;
}

/**
 * Proving the two things readiness cannot.
 *
 * Readiness asks the provider whether the records check out. That is not the
 * same as a message arriving: a domain can be green on every step and still
 * have mail refused. So the first probe sends a real message and lets the
 * operator look in their own inbox.
 *
 * The second proves something no provider dashboard can, because it is about
 * *our* code rather than theirs: that a refusal travels the whole way — the
 * provider records it, the poller collects it, and it surfaces where an
 * operator will see it.
 *
 * Note what it deliberately does *not* claim. Whether the address is then
 * suppressed depends on how the failure classifies, and Scaleway attaches no
 * flag and no SMTP code to a DNS-level refusal — so `non-existing domain or no
 * MX found` comes back `unknown` and is recorded without ending correspondence.
 * That is the classifier erring the safe way on purpose, and the probe reports
 * what happened rather than promising an outcome.
 */
@Injectable()
export class MailTestService {
  private readonly logger = new Logger(MailTestService.name);

  constructor(
    private readonly sender: MailSendService,
    private readonly suppressions: MailSuppressionService,
    private readonly config: ConfigService,
  ) {}

  /**
   * What would be sent, before anything is.
   *
   * The whole message is handed to the caller — sender, recipient, subject,
   * body — so a person can read it and change it rather than press a button
   * and find out afterwards where their mail went. Composed here rather than in
   * each client because the sender address follows a rule (`MAIL_FROM` only
   * when it belongs to this domain) and two implementations of that rule would
   * eventually disagree.
   */
  draft(domain: string, callerEmail?: string): MailTestDraft {
    const name = domain.trim().toLowerCase();
    return {
      delivery: {
        from: this.from(name),
        to: callerEmail ?? '',
        subject: `Flui test message from ${name}`,
        text: [
          `This is a test message sent by Flui from ${name}.`,
          '',
          'If it reached you, that domain can authenticate and deliver — which is more',
          'than a green readiness check proves on its own.',
          '',
          'Nobody needs to reply to this.',
        ].join('\n'),
      },
      bounce: {
        from: this.from(name),
        to: probeAddress(name),
        subject: 'Flui bounce probe',
        text:
          'Addressed to a subdomain that deliberately does not exist, so this cannot be ' +
          'delivered. The refusal is the point: it travels from the provider through the ' +
          'poller into the activity list, where you can watch it arrive.',
      },
    };
  }

  async run(
    domain: string,
    kind: MailTestKind,
    message: { to?: string; subject?: string; text?: string } = {},
    target: MailTestTarget = {},
  ): Promise<MailTestResult> {
    const name = domain.trim().toLowerCase();
    return kind === 'bounce'
      ? this.probe(name, message, target)
      : this.delivery(name, message, target);
  }

  private async delivery(
    domain: string,
    message: { to?: string; subject?: string; text?: string },
    target: MailTestTarget,
  ): Promise<MailTestResult> {
    const draft = this.draft(domain).delivery;
    const recipient = message.to?.trim() || draft.to;
    if (!recipient) {
      throw new Error(
        'No recipient. Send the test to an address you can actually open.',
      );
    }

    const result = await this.sender.send(
      {
        from: { email: draft.from, name: this.productName() },
        // One address, deliberately. What makes a send tool a sending channel is
        // the ability to address people who did not trigger it, and that is the
        // line Transactional Email's terms draw too.
        to: [{ email: recipient }],
        subject: message.subject?.trim() || draft.subject,
        text: message.text ?? draft.text,
        // A bulk sender is tested as bulk: its terms, its suppression rules and
        // its capability check are all different, and probing it as
        // transactional would answer a question nobody asked.
        scope: target.scope ?? 'transactional',
      },
      target.driver,
    );

    return {
      kind: 'delivery',
      from: draft.from,
      to: recipient,
      provider: result.provider,
      messageId: result.messageId,
      accepted: result.accepted,
    };
  }

  /**
   * Deliberately a stable address rather than a fresh one per run.
   *
   * A unique address each time would leave a growing pile of near-identical
   * rows in the suppression list, and would never exercise the interesting
   * half: the second run being refused *before* anything is sent is the visible
   * proof that the first bounce was recorded and is now being honoured.
   */
  private async probe(
    domain: string,
    message: { subject?: string; text?: string },
    target: MailTestTarget,
  ): Promise<MailTestResult> {
    const draft = this.draft(domain).bounce;
    const from = draft.from;
    const to = draft.to;
    const scope = target.scope ?? 'transactional';
    const held = await this.suppressions.suppressed([to], scope);

    if (held.length > 0) {
      return {
        kind: 'bounce',
        from,
        to,
        // Asked rather than assumed. This is the one report produced without
        // sending, so there is no result to read the provider off — and naming
        // Scaleway here was wrong from the moment a second provider could hold
        // the scope.
        provider: target.provider ?? (await this.sender.providerNameFor(scope)),
        messageId: null,
        accepted: 0,
        alreadySuppressed: true,
      };
    }

    const result = await this.sender.send(
      {
        from: { email: from, name: this.productName() },
        to: [{ email: to }],
        subject: message.subject?.trim() || draft.subject,
        text: message.text ?? draft.text,
        scope,
      },
      target.driver,
    );

    this.logger.log(
      `[mail] bounce probe sent to ${to}; the verdict follows on the next poll`,
    );

    return {
      kind: 'bounce',
      from,
      to,
      provider: result.provider,
      messageId: result.messageId,
      accepted: result.accepted,
    };
  }

  /**
   * The configured sender when it belongs to this domain, `noreply@` otherwise.
   *
   * Sending a test from an address on a *different* domain would test that
   * domain instead, and report the answer under the wrong heading.
   */
  private from(domain: string): string {
    const configured = this.config.get<string>('MAIL_FROM')?.trim();
    if (configured?.toLowerCase().endsWith(`@${domain}`)) return configured;
    return `noreply@${domain}`;
  }

  private productName(): string {
    return this.config.get<string>('MAIL_FROM_NAME') ?? 'Flui';
  }
}
