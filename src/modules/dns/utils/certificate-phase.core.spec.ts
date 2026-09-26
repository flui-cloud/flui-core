import { certificatePhaseOf } from './certificate-phase.core';

const base = {
  certificateRequired: true,
  certificateStatus: 'issuing',
  certificateMessage: 'Issuing certificate as Secret does not exist',
  certificateDeferredSince: null,
  sharedCertificate: false,
};

describe('certificatePhaseOf', () => {
  it('waits for the name in a short line, the nameservers behind the details', () => {
    const p = certificatePhaseOf({
      ...base,
      certificateStatus: 'pending',
      certificateDeferredSince: new Date(),
      certificateMessage:
        'Waiting for the name to be published: x is not published yet on ns1.',
    });
    expect(p.step).toBe('publishing');
    expect(p.label).toBe('Waiting for the name to be published');
    expect(p.detail).toBe('Usually a few minutes, at most an hour.');
    expect(p.technical).toContain('not published yet on ns1');
  });

  it('says the certificate is on its way once the name is out, keeping the raw message apart', () => {
    const p = certificatePhaseOf(base);
    expect(p).toEqual({
      step: 'issuing',
      label: 'Name published, certificate on its way',
      detail: 'Usually a few minutes, at most an hour.',
      technical: 'Issuing certificate as Secret does not exist',
    });
  });

  it('turns an hour without the name into an error with its cause', () => {
    const p = certificatePhaseOf({
      ...base,
      certificateStatus: 'failed',
      certificateDeferredSince: new Date(0),
      certificateMessage: 'Still not published after an hour: …',
    });
    expect(p.step).toBe('failed');
    expect(p.label).toBe('Name not published');
    expect(p.detail).toContain('after an hour');
    expect(p.technical).toContain('Still not published');
  });

  it('puts a failed order in plain words and the raw reason behind it', () => {
    const p = certificatePhaseOf({
      ...base,
      certificateStatus: 'failed',
      certificateMessage: 'acme: 429 rateLimited',
    });
    expect(p.label).toBe('Certificate failed');
    expect(p.technical).toBe('acme: 429 rateLimited');
  });

  it('credits the shared certificate when it is valid', () => {
    const p = certificatePhaseOf({
      ...base,
      certificateStatus: 'valid',
      sharedCertificate: true,
    });
    expect(p.step).toBe('issued');
    expect(p.detail).toBe("Covered by the zone's shared certificate.");
  });

  it('has nothing to say when no certificate is asked for', () => {
    expect(
      certificatePhaseOf({ ...base, certificateRequired: false }).step,
    ).toBe('none');
  });
});
