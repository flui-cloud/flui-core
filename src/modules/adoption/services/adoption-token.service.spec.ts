import { ConfigService } from '@nestjs/config';
import { AdoptionTokenService } from './adoption-token.service';

function serviceWith(secret?: string): AdoptionTokenService {
  return new AdoptionTokenService({
    get: (name: string) => (name === 'JWT_SECRET' ? secret : undefined),
  } as unknown as ConfigService);
}

const INPUT = {
  clusterId: 'cluster-1',
  endpoint: 'https://abc123.public.flui.cloud',
};

describe('AdoptionTokenService', () => {
  it('round-trips an issued token', () => {
    const service = serviceWith('a-real-jwt-secret');
    const { token } = service.issue(INPUT);

    const verdict = service.verify(token);
    expect(verdict.valid).toBe(true);
    expect(verdict.payload?.clusterId).toBe('cluster-1');
    expect(verdict.payload?.endpoint).toBe(INPUT.endpoint);
  });

  it('carries the endpoint so the CLI does not have to be told', () => {
    const service = serviceWith('a-real-jwt-secret');
    const { token } = service.issue(INPUT);
    expect(service.peekEndpoint(token)).toBe(INPUT.endpoint);
  });

  it('rejects a token signed by another installation', () => {
    const { token } = serviceWith('secret-of-installation-a').issue(INPUT);
    const verdict = serviceWith('secret-of-installation-b').verify(token);

    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toMatch(/signature/i);
  });

  it('rejects a tampered payload rather than trusting it', () => {
    const service = serviceWith('a-real-jwt-secret');
    const { token } = service.issue(INPUT);

    const [body, signature] = token.replace('flui_adopt_', '').split('.');
    const forged = JSON.parse(Buffer.from(body, 'base64url').toString());
    forged.clusterId = 'someone-elses-cluster';
    const swapped = `flui_adopt_${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${signature}`;

    expect(service.verify(swapped).valid).toBe(false);
  });

  it('rejects an expired token', () => {
    const service = serviceWith('a-real-jwt-secret');
    const { token } = service.issue(INPUT);

    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 3601 * 1000);
    const verdict = service.verify(token);
    jest.restoreAllMocks();

    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toMatch(/expired/i);
  });

  it('rejects a token that has already been spent', () => {
    const service = serviceWith('a-real-jwt-secret');
    const { token } = service.issue(INPUT);
    const jti = service.verify(token).payload!.jti;

    const verdict = service.verify(token, [jti]);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toMatch(/already been used/i);
  });

  it('issues a distinct token every time', () => {
    const service = serviceWith('a-real-jwt-secret');
    expect(service.issue(INPUT).token).not.toEqual(service.issue(INPUT).token);
  });

  it('rejects anything that is not an adoption token', () => {
    const service = serviceWith('a-real-jwt-secret');
    for (const value of [
      '',
      'nonsense',
      'flui_adopt_',
      'flui_adopt_abc',
      'Bearer x.y',
    ]) {
      expect(service.verify(value).valid).toBe(false);
    }
  });

  it('refuses to work at all without a signing secret', () => {
    // An unsigned or predictably-signed token would let anyone who can reach
    // this endpoint enrol their own certificate authority.
    expect(() => serviceWith(undefined).issue(INPUT)).toThrow(/JWT_SECRET/);
  });
});
