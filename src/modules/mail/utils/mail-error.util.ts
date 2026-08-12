import {
  BadGatewayException,
  BadRequestException,
  HttpException,
  PreconditionFailedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  DomainNotVerifiedError,
  MailAuthError,
  MailError,
  MailRejectedError,
} from '@flui-cloud/mail';

/**
 * Nothing is set up to do this yet.
 *
 * Its own class because it is not a provider failure and must not be reported
 * as one: "no bulk sender is configured" is an instruction, while a 502 reads
 * as an outage and sends the operator to look for something that is broken.
 */
export class MailNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailNotConfiguredError';
  }
}

/**
 * A thrown value as text, for a log line.
 *
 * `String(error)` is the obvious spelling and the wrong one: anything that is
 * not an Error or a string renders as `[object Object]`, which is the log entry
 * that tells you a failure happened and nothing else about it.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return JSON.stringify(error) ?? 'unknown error';
}

/**
 * Keep the provider's own words, and put the blame in the right place.
 *
 * Left alone, every one of these surfaces as `500 Internal server error`,
 * because they are plain `Error`s rather than Nest exceptions — and the text
 * they carry is the only thing that explains the failure. A refused bulk send
 * would read as "the platform is broken" instead of "this provider's terms do
 * not allow it, use another one".
 *
 * The status is the interesting part:
 *
 * - **rejected** is the caller's to fix — the scope, the address, the body —
 *   so it is a 4xx and the message goes back verbatim.
 * - **auth** is *ours*. The caller did nothing wrong and cannot fix a
 *   credential they never supplied, so it is a 502 and the detail stays
 *   generic; the specifics belong in the log, not in a response.
 * - **not verified** is actionable and names the missing records.
 */
export function toMailHttpError(error: unknown): unknown {
  if (error instanceof HttpException) return error;

  // A missing configuration is the caller's next step, not a fault.
  if (error instanceof MailNotConfiguredError) {
    return new PreconditionFailedException(error.message);
  }

  if (error instanceof DomainNotVerifiedError) {
    return new UnprocessableEntityException({
      message: error.message,
      domain: error.domain,
      missing: error.missing,
    });
  }
  if (error instanceof MailAuthError) {
    return new BadGatewayException(
      `The mail provider rejected Flui's credentials. Check the connected key and its permissions.`,
    );
  }
  if (error instanceof MailRejectedError) {
    return new BadRequestException(error.message);
  }
  if (error instanceof MailError) {
    return new BadGatewayException(error.message);
  }
  return error;
}
