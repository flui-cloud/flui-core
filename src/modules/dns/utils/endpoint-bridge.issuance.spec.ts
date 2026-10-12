import {
  certificateIssuance,
  certificateRefusalNote,
  certificateRequestFailed,
  latestOwned,
  shortCertificateReason,
} from './endpoint-bridge-issuance.core';

const FINALIZE_403 =
  'Failed to finalize Order: 403 urn:ietf:params:acme:error:unauthorized: Error finalizing order :: authorizations for these identifiers not valid';

const failedCertificate = (over: Record<string, unknown> = {}) => ({
  metadata: { name: 'tls-shop-example-com', namespace: 'ns' },
  status: {
    conditions: [
      {
        type: 'Ready',
        status: 'False',
        reason: 'DoesNotExist',
        message: 'Issuing certificate as Secret does not exist',
        lastTransitionTime: '2026-10-12T09:00:01Z',
      },
      {
        type: 'Issuing',
        status: 'False',
        reason: 'Failed',
        message:
          'The certificate request has failed to complete and will be retried: Failed to wait for order resource "tls-shop-example-com-1-3150245632" to become ready: order is in "errored" state: ' +
          FINALIZE_403,
        lastTransitionTime: '2026-10-12T09:00:40Z',
      },
    ],
    lastFailureTime: '2026-10-12T09:00:40Z',
    failedIssuanceAttempts: 1,
    ...over,
  },
});

const failedRequest = {
  metadata: {
    name: 'tls-shop-example-com-1',
    annotations: { 'cert-manager.io/certificate-revision': '1' },
    ownerReferences: [{ kind: 'Certificate', name: 'tls-shop-example-com' }],
  },
  status: {
    failureTime: '2026-10-12T09:00:40Z',
    conditions: [
      { type: 'Approved', status: 'True', reason: 'cert-manager.io' },
      {
        type: 'Ready',
        status: 'False',
        reason: 'Failed',
        message:
          'Failed to wait for order resource "tls-shop-example-com-1-3150245632" to become ready: order is in "errored" state: ' +
          FINALIZE_403,
      },
    ],
  },
};

const erroredOrder = {
  metadata: {
    name: 'tls-shop-example-com-1-3150245632',
    ownerReferences: [
      { kind: 'CertificateRequest', name: 'tls-shop-example-com-1' },
    ],
  },
  status: {
    state: 'errored',
    reason: FINALIZE_403,
    failureTime: '2026-10-12T09:00:40Z',
  },
};

describe('certificateIssuance', () => {
  it('is ready once cert-manager reports the Certificate Ready', () => {
    expect(
      certificateIssuance({
        status: {
          conditions: [{ type: 'Ready', status: 'True', reason: 'Ready' }],
        },
      }),
    ).toEqual({ state: 'ready' });
  });

  it('is issuing while no Certificate exists yet or a try is under way', () => {
    expect(certificateIssuance(null)).toEqual({ state: 'issuing' });
    expect(
      certificateIssuance({
        status: {
          conditions: [
            { type: 'Ready', status: 'False', reason: 'DoesNotExist' },
            { type: 'Issuing', status: 'True', reason: 'DoesNotExist' },
          ],
        },
      }),
    ).toEqual({ state: 'issuing' });
  });

  it('treats a try started after an earlier failure as issuing', () => {
    const certificate = failedCertificate();
    certificate.status.conditions[1] = {
      type: 'Issuing',
      status: 'True',
      reason: 'DoesNotExist',
      message: 'Issuing certificate as Secret does not exist',
      lastTransitionTime: '2026-10-12T10:00:41Z',
    };
    expect(certificateIssuance(certificate)).toEqual({ state: 'issuing' });
  });

  it('reads a refused finalize from the errored Order, with the one-hour backoff', () => {
    expect(
      certificateIssuance(failedCertificate(), failedRequest, erroredOrder),
    ).toEqual({
      state: 'failed',
      reason: FINALIZE_403,
      failedAt: '2026-10-12T09:00:40Z',
      retryAt: '2026-10-12T10:00:40.000Z',
    });
  });

  it('falls back to the CertificateRequest, then to the Issuing condition, for the reason', () => {
    const fromRequest = certificateIssuance(failedCertificate(), failedRequest);
    expect(fromRequest).toEqual(
      expect.objectContaining({
        state: 'failed',
        reason: expect.stringMatching(/^Failed to wait for order resource/),
      }),
    );
    const fromCondition = certificateIssuance(failedCertificate());
    expect(fromCondition).toEqual(
      expect.objectContaining({
        reason: expect.stringMatching(/^The certificate request has failed/),
      }),
    );
  });

  it('doubles the backoff per failed attempt, up to 32 hours', () => {
    const third = certificateIssuance(
      failedCertificate({ failedIssuanceAttempts: 3 }),
    );
    expect(third).toEqual(
      expect.objectContaining({ retryAt: '2026-10-12T13:00:40.000Z' }),
    );
    const many = certificateIssuance(
      failedCertificate({ failedIssuanceAttempts: 9 }),
    );
    expect(many).toEqual(
      expect.objectContaining({ retryAt: '2026-10-13T17:00:40.000Z' }),
    );
  });

  it('still sees the failure from the Issuing condition alone', () => {
    const certificate = failedCertificate({
      lastFailureTime: undefined,
      failedIssuanceAttempts: undefined,
    });
    expect(certificateIssuance(certificate)).toEqual(
      expect.objectContaining({
        state: 'failed',
        failedAt: '2026-10-12T09:00:40Z',
      }),
    );
  });
});

describe('certificateRequestFailed and latestOwned', () => {
  it('tells a failed request from a pending one', () => {
    expect(certificateRequestFailed(failedRequest)).toBe(true);
    expect(
      certificateRequestFailed({
        status: {
          conditions: [{ type: 'Ready', status: 'False', reason: 'Pending' }],
        },
      }),
    ).toBe(false);
    expect(certificateRequestFailed(null)).toBe(false);
  });

  it('picks the newest revision the Certificate owns', () => {
    const other = {
      metadata: {
        name: 'tls-other-1',
        annotations: { 'cert-manager.io/certificate-revision': '9' },
        ownerReferences: [{ kind: 'Certificate', name: 'tls-other' }],
      },
    };
    const second = {
      metadata: {
        name: 'tls-shop-example-com-2',
        annotations: { 'cert-manager.io/certificate-revision': '2' },
        ownerReferences: [
          { kind: 'Certificate', name: 'tls-shop-example-com' },
        ],
      },
    };
    expect(
      latestOwned(
        [failedRequest, other, second],
        'Certificate',
        'tls-shop-example-com',
      ),
    ).toBe(second);
    expect(
      latestOwned([other], 'Certificate', 'tls-shop-example-com'),
    ).toBeNull();
  });
});

describe('certificate refusal notes', () => {
  it('keeps the ACME problem type and detail only', () => {
    expect(shortCertificateReason(FINALIZE_403)).toBe(
      'unauthorized: authorizations for these identifiers not valid',
    );
    expect(shortCertificateReason('  rate   limited\n')).toBe('rate limited');
  });

  it('says what Flui did about the refusal', () => {
    expect(
      certificateRefusalNote('shop.example.com', FINALIZE_403, {
        kind: 'retried',
      }),
    ).toBe(
      "Let's Encrypt refused the certificate for shop.example.com (unauthorized: authorizations for these identifiers not valid); retried now.",
    );
    expect(
      certificateRefusalNote('shop.example.com', FINALIZE_403, {
        kind: 'copied',
      }),
    ).toBe(
      "Let's Encrypt refused the certificate for shop.example.com (unauthorized: authorizations for these identifiers not valid); using the source's certificate until the new cluster has its own.",
    );
    expect(
      certificateRefusalNote('shop.example.com', FINALIZE_403, {
        kind: 'stuck',
        why: "the source's certificate cannot be used: it is a wildcard",
        retryAt: '2026-10-12T10:00:40.000Z',
      }),
    ).toBe(
      "Let's Encrypt refused the certificate for shop.example.com (unauthorized: authorizations for these identifiers not valid); retries did not help and the source's certificate cannot be used: it is a wildcard. cert-manager tries again from 2026-10-12T10:00:40.000Z.",
    );
  });
});
