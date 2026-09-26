import {
  endpointSyncOutcome,
  syncCertificateAction,
} from './endpoint-sync.core';

const base = {
  fqdn: 'shop.example.com',
  alreadyRunning: false,
  dns: 'record' as const,
  dnsValue: '203.0.113.7',
  certificate: 'valid' as const,
  certificateStatus: 'valid',
  failure: null,
};

describe('endpointSyncOutcome', () => {
  it('says each part in order when everything is in place', () => {
    const out = endpointSyncOutcome(base);
    expect(out.actions).toEqual([
      'The address record points shop.example.com to 203.0.113.7.',
      'The route to the application is in place.',
      'The certificate is valid.',
    ]);
    expect(out.certificateRetried).toBe(false);
  });

  it('names the failure it retried', () => {
    const out = endpointSyncOutcome({
      ...base,
      certificate: 'retried',
      failure: 'rate limited',
    });
    expect(out.certificateRetried).toBe(true);
    expect(out.says).toContain(
      'The certificate had failed (rate limited); Flui asked for a new one.',
    );
  });

  it('credits the wildcard record rather than a per-app one', () => {
    const out = endpointSyncOutcome({ ...base, dns: 'wildcard' });
    expect(out.actions[0]).toBe(
      "The zone's wildcard record already answers for shop.example.com.",
    );
  });

  it('leaves the address out when Flui does not manage it', () => {
    const out = endpointSyncOutcome({
      ...base,
      dns: 'none',
      certificate: 'not-required',
    });
    expect(out.actions).toEqual([
      'The route to the application is in place.',
      'No certificate is asked for.',
    ]);
  });

  it('says a sync already running was not started twice', () => {
    const out = endpointSyncOutcome({ ...base, alreadyRunning: true });
    expect(out.says).toBe(
      'A sync of shop.example.com is already running; nothing was started twice.',
    );
    expect(out.certificateRetried).toBe(false);
  });
});

describe('syncCertificateAction', () => {
  it.each([
    [false, 'valid', 'valid'],
    [false, 'issuing', 'issuing'],
    [false, 'expired', 'failed'],
    [false, 'pending', 'requested'],
    [false, null, 'requested'],
    [true, 'valid', 'shared'],
  ])('shared=%s status=%s → %s', (shared, status, expected) => {
    expect(
      syncCertificateAction(shared as boolean, status as string | null),
    ).toBe(expected);
  });
});
