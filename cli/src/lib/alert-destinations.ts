import { ApiClient } from './api-client';
import { ConfigStorage } from './config-storage';

export type AlertSeverityFloor = 'warning' | 'critical';
export type AlertDestinationScope = 'infrastructure' | 'all';

export interface AlertDestination {
  id: string;
  kind: 'email' | 'webhook';
  target: string;
  minSeverity: AlertSeverityFloor;
  scope: AlertDestinationScope;
  enabled: boolean;
  signed: boolean;
  createdBy: string | null;
  createdAt: string;
  lastDeliveryAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
}

export interface CreatedAlertDestination extends AlertDestination {
  secret: string | null;
}

export interface AlertDestinationTestResult {
  ok: boolean;
  status: string | null;
  error: string | null;
}

export const DESTINATIONS_PATH = '/observability/alert-destinations';
export const ADMIN_ROUTING_PATH = '/observability/alert-routing/admins';

export function alertsApi(): ApiClient {
  const config = new ConfigStorage();
  return new ApiClient({
    baseUrl: config.getApiUrlOrThrow(),
    apiKey: config.getApiKeyOrThrow(),
  });
}

/** The request body for `add`, from exactly one of `--email` or `--webhook`. */
export function destinationBody(flags: {
  email?: string;
  webhook?: string;
  'min-severity'?: string;
  scope?: string;
}): {
  kind: 'email' | 'webhook';
  target: string;
  minSeverity: AlertSeverityFloor;
  scope: AlertDestinationScope;
} {
  const { email, webhook } = flags;
  if (Boolean(email) === Boolean(webhook)) {
    throw new Error('Pass exactly one of --email or --webhook.');
  }
  return {
    kind: email ? 'email' : 'webhook',
    target: (email ?? webhook) as string,
    minSeverity: (flags['min-severity'] ?? 'critical') as AlertSeverityFloor,
    scope: (flags.scope ?? 'infrastructure') as AlertDestinationScope,
  };
}

function describeLastDelivery(d: AlertDestination): string {
  if (!d.lastDeliveryAt) return 'nothing delivered yet';
  const error = d.lastError ? ` — ${d.lastError}` : '';
  const at = d.lastDeliveryAt.replace('T', ' ').slice(0, 19);
  return `last ${d.lastStatus ?? '?'} at ${at}${error}`;
}

/** One line per destination: how it is reached, what it hears, how it last went. */
export function describeDestination(d: AlertDestination): string {
  const state = d.enabled ? '' : ' (paused)';
  const last = describeLastDelivery(d);
  const hears = d.scope === 'all' ? 'all apps' : 'infrastructure';
  return `${d.id}  ${d.kind.padEnd(7)}  ${d.minSeverity.padEnd(8)}  ${hears.padEnd(14)}  ${d.target}${state}\n    ${last}`;
}
