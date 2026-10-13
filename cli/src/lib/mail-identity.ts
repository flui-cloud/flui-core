export interface MailIdentityStatus {
  state: 'active' | 'attention' | 'not_configured' | 'error';
  reason: string | null;
  mailProvider: string | null;
  providerId: string | null;
  active: boolean;
  endpoint: string | null;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  lastDeliveryAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
}

const REASONS: Record<string, string> = {
  identity_provider_unreachable:
    'Flui has no service account for the identity provider.',
  endpoint_unknown:
    'This API does not run inside the cluster, so the identity provider cannot reach it.',
  no_transactional_connection:
    'No transactional mail provider is connected. Run `flui mail connect`.',
  no_sender:
    'No sender address: set MAIL_FROM, or give the transactional connection a sending domain.',
  sender_not_ready:
    'The transactional provider is not ready to send yet. See `flui mail readiness`.',
  sync_failed: 'The last sync with the identity provider failed.',
};

const STATES: Record<MailIdentityStatus['state'], string> = {
  active: 'Sign-in emails are sent through',
  attention: 'Sign-in emails are pointed at Flui, but cannot go out through',
  not_configured: 'Sign-in emails are not sent through Flui yet',
  error: 'Sign-in emails could not be set up to go through',
};

export function describeReason(reason: string | null): string | null {
  if (!reason) return null;
  return REASONS[reason] ?? reason;
}

export function mailIdentityLines(status: MailIdentityStatus): string[] {
  const provider = status.mailProvider ?? 'no provider';
  const headline =
    status.state === 'not_configured'
      ? STATES.not_configured
      : `${STATES[status.state]} ${provider}`;
  const lines = [headline];
  const why = describeReason(status.reason);
  if (why) lines.push(`Why: ${why}`);
  if (status.providerId)
    lines.push(`Identity provider entry: ${status.providerId}`);
  if (status.endpoint) lines.push(`Endpoint: ${status.endpoint}`);
  if (status.lastDeliveryAt)
    lines.push(`Last delivery: ${status.lastDeliveryAt}`);
  if (status.lastError) {
    lines.push(
      `Last error: ${status.lastError} (${status.lastErrorAt ?? 'unknown time'})`,
    );
  }
  if (status.lastSyncError)
    lines.push(`Last sync error: ${status.lastSyncError}`);
  if (status.lastSyncAt) lines.push(`Last checked: ${status.lastSyncAt}`);
  return lines;
}
