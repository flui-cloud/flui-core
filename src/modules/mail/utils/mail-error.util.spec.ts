import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import {
  DomainNotVerifiedError,
  MailAuthError,
  MailError,
  MailRejectedError,
} from '@flui-cloud/mail';
import { toMailHttpError } from './mail-error.util';

const status = (error: unknown) => (error as HttpException).getStatus();

describe('toMailHttpError', () => {
  it('keeps the provider text on a rejection, because it is the only explanation', () => {
    // Left unmapped this surfaced as `500 Internal server error` and the
    // sentence explaining the refusal was discarded — a refused bulk send read
    // as "the platform is broken".
    const mapped = toMailHttpError(
      new MailRejectedError(
        'scaleway-tem does not carry bulk mail.',
        'scaleway-tem',
      ),
    );
    expect(status(mapped)).toBe(HttpStatus.BAD_REQUEST);
    expect((mapped as HttpException).message).toMatch(
      /does not carry bulk mail/,
    );
  });

  it('puts an auth failure on us, not on the caller, and says nothing specific', () => {
    // The caller cannot fix a credential they never supplied, and the provider's
    // wording about our key does not belong in their response.
    const mapped = toMailHttpError(
      new MailAuthError('invalid secret key abc123', 'scaleway-tem'),
    );
    expect(status(mapped)).toBe(HttpStatus.BAD_GATEWAY);
    expect((mapped as HttpException).message).not.toMatch(/abc123/);
  });

  it('names the missing records when a domain is not verified', () => {
    const mapped = toMailHttpError(
      new DomainNotVerifiedError(
        'example.com',
        ['spf', 'dkim'],
        'scaleway-tem',
      ),
    );
    expect(status(mapped)).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect((mapped as HttpException).getResponse()).toMatchObject({
      domain: 'example.com',
      missing: ['spf', 'dkim'],
    });
  });

  it('treats an unclassified provider failure as an upstream problem', () => {
    expect(
      status(toMailHttpError(new MailError('gateway timeout', 'scaleway-tem'))),
    ).toBe(HttpStatus.BAD_GATEWAY);
  });

  it('passes an HttpException through untouched', () => {
    const original = new BadRequestException('already shaped');
    expect(toMailHttpError(original)).toBe(original);
  });

  it('leaves anything else alone rather than dressing it up as a mail failure', () => {
    // A bug in our own code is not the provider's fault, and reporting it as one
    // sends whoever reads the log to the wrong place.
    const bug = new TypeError('cannot read properties of undefined');
    expect(toMailHttpError(bug)).toBe(bug);
  });
});
