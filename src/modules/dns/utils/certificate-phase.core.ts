/**
 * Where an endpoint's certificate is, in the words a person reads: the name
 * first has to be published, then the certificate authority checks it, then
 * the certificate is there. cert-manager's own message is kept apart as the
 * technical detail, behind a button, because it names resources nobody
 * deploying an application works with.
 */

export type CertificatePhaseStep =
  | 'none'
  | 'publishing'
  | 'issuing'
  | 'issued'
  | 'failed';

export interface CertificatePhase {
  step: CertificatePhaseStep;
  label: string;
  /** One or two plain sentences; null when the label says it all. */
  detail: string | null;
  /** The raw message from the certificate machinery, for whoever wants it. */
  technical: string | null;
}

export interface CertificatePhaseFacts {
  certificateRequired: boolean;
  certificateStatus: string | null;
  certificateMessage: string | null;
  certificateDeferredSince: Date | null;
  sharedCertificate: boolean;
}

export function certificatePhaseOf(
  facts: CertificatePhaseFacts,
): CertificatePhase {
  const { certificateStatus: status, certificateMessage: message } = facts;
  if (!facts.certificateRequired) {
    return {
      step: 'none',
      label: 'No certificate',
      detail: null,
      technical: null,
    };
  }

  if (facts.certificateDeferredSince) {
    return status === 'failed'
      ? {
          step: 'failed',
          label: 'Name not published',
          detail:
            'Still not published after an hour. Check the record at the DNS provider, then Sync.',
          technical: message,
        }
      : {
          step: 'publishing',
          label: 'Waiting for the name to be published',
          detail: 'Usually a few minutes, at most an hour.',
          technical: message,
        };
  }

  switch (status) {
    case 'valid':
      return {
        step: 'issued',
        label: 'Certificate issued',
        detail: facts.sharedCertificate
          ? "Covered by the zone's shared certificate."
          : null,
        technical: null,
      };
    case 'expired':
      return {
        step: 'failed',
        label: 'Certificate expired',
        detail: 'It was not renewed in time. Sync orders a new one.',
        technical: message,
      };
    case 'failed':
      return {
        step: 'failed',
        label: 'Certificate failed',
        detail:
          'The certificate authority could not confirm the name. Sync orders it again.',
        technical: message,
      };
    default:
      return {
        step: 'issuing',
        label: 'Name published, certificate on its way',
        detail: 'Usually a few minutes, at most an hour.',
        technical: message,
      };
  }
}
