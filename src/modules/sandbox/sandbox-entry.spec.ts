import {
  SANDBOX_PLACEHOLDER_BASE_DOMAIN,
  describeSandboxEntry,
  entryUrl,
  loginUrl,
} from './sandbox-entry';

/**
 * One door, and the environment decides where it is.
 *
 * The point of the shape being fixed in code while the origin is not: moving the
 * demo from a laptop to a public name has to be a variable, never an edit. If
 * anything here starts taking a hostname from a literal, that promise is gone.
 */
describe('the sandbox door', () => {
  it('is the configured origin plus /try, whatever the origin is', () => {
    expect(entryUrl('try.flui.cloud')).toBe('https://try.flui.cloud/try');
    expect(entryUrl('http://localhost:4200')).toBe('http://localhost:4200/try');
    expect(entryUrl('app.tidy-marmot.109-123-252-6.nip.io')).toBe(
      'https://app.tidy-marmot.109-123-252-6.nip.io/try',
    );
  });

  it('does not double the slash when the origin is configured with one', () => {
    expect(loginUrl('http://localhost:4200/')).toBe('http://localhost:4200');
    expect(entryUrl('http://localhost:4200/')).toBe(
      'http://localhost:4200/try',
    );
  });
});

/**
 * A URL that lives in the environment is wrong silently.
 *
 * Nothing about a claim fails when the door points nowhere: the tenancy is real,
 * the credential is real, and the visitor is redirected into a name that does
 * not resolve. So the instance has to say it at boot, the way it already does
 * for `WEBHOOK_BASE_URL`.
 */
describe('what the instance says about its own door', () => {
  it('warns when nobody chose the domain and the placeholder is in force', () => {
    const report = describeSandboxEntry(SANDBOX_PLACEHOLDER_BASE_DOMAIN);

    expect(report.verdict).toBe('placeholder');
    expect(report.message).toContain('SANDBOX_BASE_DOMAIN');
  });

  it('calls a localhost door local rather than broken', () => {
    // The only instantiation that exists today. It is correct, and a warning
    // about it would train an operator to ignore the one that is not.
    expect(describeSandboxEntry('http://localhost:4200').verdict).toBe('local');
    expect(describeSandboxEntry('http://127.0.0.1:4200').verdict).toBe('local');
  });

  it('is satisfied by any origin somebody actually chose', () => {
    const report = describeSandboxEntry(
      'app.tidy-marmot-nf.109-123-252-6.nip.io',
    );

    expect(report.verdict).toBe('ok');
    expect(report.entryUrl).toBe(
      'https://app.tidy-marmot-nf.109-123-252-6.nip.io/try',
    );
  });
});
