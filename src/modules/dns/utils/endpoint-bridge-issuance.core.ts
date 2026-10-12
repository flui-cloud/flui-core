interface CertManagerCondition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

interface CertManagerObject {
  metadata?: {
    name?: string;
    creationTimestamp?: string;
    annotations?: Record<string, string>;
    ownerReferences?: { kind: string; name: string }[];
  };
}

export interface CertManagerCertificate extends CertManagerObject {
  status?: {
    conditions?: CertManagerCondition[];
    lastFailureTime?: string;
    failedIssuanceAttempts?: number;
  };
}

export interface CertManagerRequest extends CertManagerObject {
  status?: { conditions?: CertManagerCondition[]; failureTime?: string };
}

export interface AcmeOrder extends CertManagerObject {
  status?: { state?: string; reason?: string; failureTime?: string };
}

export type CertificateIssuance =
  | { state: 'ready' }
  | { state: 'issuing' }
  | {
      state: 'failed';
      reason: string;
      failedAt: string | null;
      retryAt: string | null;
    };

const MAX_BACKOFF_HOURS = 32;

const condition = (
  o: { status?: { conditions?: CertManagerCondition[] } },
  type: string,
) => (o.status?.conditions ?? []).find((c) => c.type === type);

/** The CertificateRequest has ended without a certificate. */
export function certificateRequestFailed(
  request: CertManagerRequest | null | undefined,
): boolean {
  const ready = request ? condition(request, 'Ready') : undefined;
  return ready?.status === 'False' && ready.reason !== 'Pending';
}

/** The newest object among these that the named owner controls. */
export function latestOwned<T extends CertManagerObject>(
  items: T[],
  ownerKind: string,
  ownerName: string,
): T | null {
  const owned = items.filter((i) =>
    (i.metadata?.ownerReferences ?? []).some(
      (o) => o.kind === ownerKind && o.name === ownerName,
    ),
  );
  const revision = (i: T) =>
    Number(i.metadata?.annotations?.['cert-manager.io/certificate-revision']);
  const created = (i: T) => Date.parse(i.metadata?.creationTimestamp ?? '');
  owned.sort(
    (a, b) =>
      (revision(b) || 0) - (revision(a) || 0) ||
      (created(b) || 0) - (created(a) || 0),
  );
  return owned[0] ?? null;
}

/**
 * Where cert-manager stands on a Certificate. A failed issuance waits out
 * cert-manager's backoff (1h, doubling per failed attempt up to 32h) before it
 * is tried again; an Issuing condition that is True means a try is under way.
 */
export function certificateIssuance(
  certificate: CertManagerCertificate | null | undefined,
  request?: CertManagerRequest | null,
  order?: AcmeOrder | null,
): CertificateIssuance {
  if (!certificate) return { state: 'issuing' };
  if (condition(certificate, 'Ready')?.status === 'True') {
    return { state: 'ready' };
  }
  const issuing = condition(certificate, 'Issuing');
  const attempts = certificate.status?.failedIssuanceAttempts ?? 0;
  const failed =
    issuing?.status !== 'True' &&
    ((issuing?.status === 'False' && issuing.reason === 'Failed') ||
      attempts > 0 ||
      !!certificate.status?.lastFailureTime);
  if (!failed) return { state: 'issuing' };

  const orderFailed =
    order?.status?.state === 'errored' || order?.status?.state === 'invalid';
  const reason =
    (orderFailed ? order?.status?.reason : undefined) ||
    (certificateRequestFailed(request)
      ? condition(request!, 'Ready')?.message
      : undefined) ||
    issuing?.message ||
    'cert-manager gave no reason';
  const failedAt =
    certificate.status?.lastFailureTime ??
    request?.status?.failureTime ??
    issuing?.lastTransitionTime ??
    null;
  const hours = Math.min(2 ** Math.max(0, attempts - 1), MAX_BACKOFF_HOURS);
  const retryAt =
    failedAt && !Number.isNaN(Date.parse(failedAt))
      ? new Date(Date.parse(failedAt) + hours * 3_600_000).toISOString()
      : null;
  return { state: 'failed', reason, failedAt, retryAt };
}

/** The ACME problem type and detail, without cert-manager's wrapping. */
export function shortCertificateReason(reason: string): string {
  const marker = 'urn:ietf:params:acme:error:';
  const at = reason.indexOf(marker);
  if (at >= 0) {
    const rest = reason.slice(at + marker.length);
    const colon = rest.indexOf(':');
    if (colon < 0) return rest.trim();
    const detail = rest
      .slice(colon + 1)
      .split(' :: ')
      .pop()
      ?.trim();
    const type = rest.slice(0, colon);
    return detail ? `${type}: ${detail}` : type;
  }
  const flat = reason.split(/\s+/).filter(Boolean).join(' ');
  return flat.length > 160 ? `${flat.slice(0, 157)}...` : flat;
}

export type CertificateRefusalOutcome =
  | { kind: 'retried' }
  | { kind: 'copied' }
  | { kind: 'stuck'; why: string; retryAt: string | null };

export function certificateRefusalNote(
  fqdn: string,
  reason: string,
  outcome: CertificateRefusalOutcome,
): string {
  const refused = `Let's Encrypt refused the certificate for ${fqdn} (${shortCertificateReason(reason)})`;
  if (outcome.kind === 'retried') return `${refused}; retried now.`;
  if (outcome.kind === 'copied') {
    return `${refused}; using the source's certificate until the new cluster has its own.`;
  }
  const next = outcome.retryAt
    ? ` cert-manager tries again from ${outcome.retryAt}.`
    : '';
  return `${refused}; retries did not help and ${outcome.why}.${next}`;
}
