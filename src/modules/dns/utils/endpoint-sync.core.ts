export type SyncCertificateAction =
  | 'not-required'
  | 'shared'
  | 'valid'
  | 'retried'
  | 'requested'
  | 'issuing'
  | 'waiting'
  | 'failed';

export interface EndpointSyncFacts {
  fqdn: string;
  alreadyRunning: boolean;
  dns: 'record' | 'wildcard' | 'none';
  dnsValue: string | null;
  certificate: SyncCertificateAction;
  certificateStatus: string | null;
  failure: string | null;
}

export interface EndpointSyncOutcome {
  certificate: SyncCertificateAction;
  certificateRetried: boolean;
  actions: string[];
  says: string;
}

export function endpointSyncOutcome(
  facts: EndpointSyncFacts,
): EndpointSyncOutcome {
  if (facts.alreadyRunning) {
    const says = `A sync of ${facts.fqdn} is already running; nothing was started twice.`;
    return {
      certificate: facts.certificate,
      certificateRetried: false,
      actions: [says],
      says,
    };
  }

  const actions: string[] = [];
  if (facts.dns === 'record') {
    actions.push(
      facts.dnsValue
        ? `The address record points ${facts.fqdn} to ${facts.dnsValue}.`
        : `The address record for ${facts.fqdn} is in place.`,
    );
  } else if (facts.dns === 'wildcard') {
    actions.push(
      `The zone's wildcard record already answers for ${facts.fqdn}.`,
    );
  }
  actions.push(
    'The route to the application is in place.',
    certificateSentence(facts),
  );

  return {
    certificate: facts.certificate,
    certificateRetried: facts.certificate === 'retried',
    actions,
    says: actions.join(' '),
  };
}

function certificateSentence(facts: EndpointSyncFacts): string {
  switch (facts.certificate) {
    case 'not-required':
      return 'No certificate is asked for.';
    case 'shared':
      return `It uses a shared certificate${nowSuffix(facts.certificateStatus)}.`;
    case 'valid':
      return 'The certificate is valid.';
    case 'retried':
      return `The certificate had failed${parenthesised(facts.failure)}; Flui asked for a new one.`;
    case 'requested':
      return 'The certificate was requested.';
    case 'issuing':
      return 'The certificate is still being issued.';
    case 'waiting':
      return (
        facts.failure ?? 'The certificate waits for the name to be published.'
      );
    case 'failed':
      if (facts.failure?.endsWith('.')) {
        return `The certificate has failed: ${facts.failure}`;
      }
      return `The certificate has failed${parenthesised(facts.failure)}.`;
  }
}

function nowSuffix(status: string | null): string {
  return status ? `, now ${status}` : '';
}

function parenthesised(text: string | null): string {
  return text ? ` (${text})` : '';
}

export function syncCertificateAction(
  shared: boolean,
  status: string | null,
): SyncCertificateAction {
  if (shared) return 'shared';
  switch (status) {
    case 'valid':
      return 'valid';
    case 'issuing':
      return 'issuing';
    case 'failed':
    case 'expired':
      return 'failed';
    default:
      return 'requested';
  }
}
