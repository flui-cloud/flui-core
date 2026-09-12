import { Sensitivity } from '../constants/sensitivity';
import { fakeValueFor, MaskSessionContext } from './fake-value.util';

describe('fakeValueFor — network-identifier', () => {
  const session: MaskSessionContext = { sub: 'user-1', iat: 1700000000 };
  const salt = 'test-salt';

  it('fakes a bare IPv4 address into the RFC 5737 documentation range', () => {
    const fake = fakeValueFor(
      Sensitivity.NETWORK_IDENTIFIER,
      '10.10.1.1',
      session,
      salt,
    );
    expect(fake).toMatch(/^203\.0\.113\.\d{1,3}$/);
  });

  it('preserves the CIDR prefix length when faking a subnet range', () => {
    const fake = fakeValueFor(
      Sensitivity.NETWORK_IDENTIFIER,
      '10.10.1.0/24',
      session,
      salt,
    );
    expect(fake).toMatch(/^203\.0\.113\.\d{1,3}\/24$/);
  });

  it('preserves an IPv6 CIDR prefix length', () => {
    const fake = fakeValueFor(
      Sensitivity.NETWORK_IDENTIFIER,
      'fd00:1::/64',
      session,
      salt,
    );
    expect(fake).toMatch(
      /^2001:db8:[0-9a-f]{4}:[0-9a-f]{4}:[0-9a-f]{4}:[0-9a-f]{4}\/64$/,
    );
  });

  it('falls back to a hostname-shaped fake for a real hostname, not a CIDR', () => {
    const fake = fakeValueFor(
      Sensitivity.NETWORK_IDENTIFIER,
      'control-cluster-local-dev-master',
      session,
      salt,
    );
    expect(fake).toMatch(/^host-[0-9a-f]{12}\.mask\.invalid$/);
  });

  it('is deterministic for the same session and value', () => {
    const first = fakeValueFor(
      Sensitivity.NETWORK_IDENTIFIER,
      '10.10.1.0/24',
      session,
      salt,
    );
    const second = fakeValueFor(
      Sensitivity.NETWORK_IDENTIFIER,
      '10.10.1.0/24',
      session,
      salt,
    );
    expect(first).toBe(second);
  });
});
