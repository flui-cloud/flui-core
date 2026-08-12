import { createTransport, type Transporter } from 'nodemailer';
import type {
  SmtpDelivery,
  SmtpMessage,
  SmtpTransport,
} from '@flui-cloud/mail';

export interface SmtpRelaySettings {
  host: string;
  port: number;
  username?: string;
  password?: string;
  /** Implicit TLS. True for 465, STARTTLS on 587 — which nodemailer upgrades to itself. */
  secure?: boolean;
}

/**
 * The concrete side of the `SmtpTransport` seam.
 *
 * It lives here rather than in `@flui-cloud/mail` because the package index has
 * to stay loadable in a browser bundle, and a socket library is the one thing
 * that guarantees it will not be. The seam exists exactly so each host can keep
 * the client it already has.
 *
 * Everything interesting in this file is the return value. Nodemailer reports
 * `accepted` and `rejected` as **per-recipient** arrays, because that is what
 * SMTP does — every address is settled individually at `RCPT TO`. For a relay
 * those verdicts are the only outcome anyone will ever learn about that
 * message, so collapsing them into a count, which is what this adapter would
 * naturally do, throws away the entire feedback loop: which address to stop
 * writing to, and why.
 */
export class NodemailerTransport implements SmtpTransport {
  private readonly transporter: Transporter;

  constructor(settings: SmtpRelaySettings) {
    this.transporter = createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.secure ?? settings.port === 465,
      ...(settings.username
        ? { auth: { user: settings.username, pass: settings.password ?? '' } }
        : {}),
      // A relay that hangs is worse than one that refuses: the caller is an
      // HTTP request holding a connection open behind it.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }

  async send(message: SmtpMessage): Promise<SmtpDelivery> {
    const info = await this.transporter.sendMail({
      from: address(message.from),
      to: message.to.map(address),
      subject: message.subject,
      ...(message.text ? { text: message.text } : {}),
      ...(message.html ? { html: message.html } : {}),
      ...(message.replyTo ? { replyTo: address(message.replyTo) } : {}),
      headers: message.headers,
    });

    const rejected = normalise(info.rejected);
    // `rejectedErrors` is aligned with `rejected` when nodemailer has per-address
    // replies; when it does not, the address is still reported and simply
    // carries no explanation — which the driver then declines to suppress on.
    const errors =
      (info as { rejectedErrors?: RelayError[] }).rejectedErrors ?? [];

    return {
      messageId: info.messageId ?? null,
      accepted: normalise(info.accepted),
      ...(rejected.length
        ? {
            rejected: rejected.map((recipient, index) => {
              const error = errors[index];
              return {
                recipient,
                ...(error?.responseCode === undefined
                  ? {}
                  : { code: error.responseCode }),
                ...(error?.message ? { reason: error.message } : {}),
              };
            }),
          }
        : {}),
    };
  }

  /** Prove the credentials and the route before a real message depends on them. */
  async verify(): Promise<void> {
    await this.transporter.verify();
  }
}

interface RelayError {
  message?: string;
  responseCode?: number;
}

function address(value: { email: string; name?: string }): string {
  return value.name ? `${value.name} <${value.email}>` : value.email;
}

/** Nodemailer reports an address as a string or as an envelope object. */
function normalise(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) =>
      typeof entry === 'string'
        ? entry
        : (entry as { address?: string })?.address,
    )
    .filter(
      (entry): entry is string => typeof entry === 'string' && entry.length > 0,
    );
}
