import { isIP } from 'node:net';
import chalk from 'chalk';
import { CliAppService, GatewayRoute } from './services/cli-app.service';

/**
 * Resolve a route of an app by host (fqdn, case-insensitive) or endpoint id
 * (full or 8-char prefix). Errors with the available hosts when not found.
 */
export async function resolveGatewayRoute(
  service: CliAppService,
  appId: string,
  hostOrId: string,
): Promise<GatewayRoute> {
  const routes = await service.listGatewayRoutes(appId);
  const needle = hostOrId.toLowerCase();
  const match = routes.find(
    (r) =>
      r.host.toLowerCase() === needle ||
      r.endpointId === hostOrId ||
      r.endpointId.startsWith(needle),
  );
  if (!match) {
    const available = routes.map((r) => r.host).join(', ') || 'none';
    throw new Error(
      `No route "${hostOrId}" on this application. Available routes: ${available}`,
    );
  }
  return match;
}

export function policySummary(route: GatewayRoute): string {
  const parts: string[] = [];
  if (route.auth?.sso) {
    parts.push(route.auth.minRole ? `sso(min:${route.auth.minRole})` : 'sso');
  }
  if (route.rateLimit?.average) {
    const burst = route.rateLimit.burst ? `+${route.rateLimit.burst}` : '';
    parts.push(
      `rate(${route.rateLimit.average}/${route.rateLimit.period ?? '1s'}${burst})`,
    );
  }
  if (route.allowIps?.length) {
    parts.push(`ips(${route.allowIps.length})`);
  }
  return parts.length ? parts.join(' ') : chalk.dim('—');
}

export function reconciliationLabel(status: string): string {
  switch (status) {
    case 'in_sync':
    case 'IN_SYNC':
      return chalk.green('synced');
    case 'error':
    case 'ERROR':
      return chalk.red('error');
    default:
      return chalk.yellow('reconciling');
  }
}

export function tlsLabel(route: GatewayRoute): string {
  if (route.tlsEnabled) return chalk.green('https');
  const phase = route.certificatePhase;
  if (phase && phase.step !== 'none') {
    return phase.step === 'failed'
      ? chalk.red(phase.label)
      : chalk.yellow(phase.label);
  }
  return route.certificateStatus
    ? chalk.yellow(String(route.certificateStatus).toLowerCase())
    : chalk.dim('http');
}

function authLabel(route: GatewayRoute): string {
  if (!route.auth?.sso) return chalk.dim('public');
  if (route.auth.minRole) {
    return chalk.green(`SSO (min role: ${route.auth.minRole})`);
  }
  return chalk.green('SSO');
}

function rateLimitLabel(route: GatewayRoute): string {
  const rl = route.rateLimit;
  if (!rl?.average) return chalk.dim('none');
  const burst = rl.burst ? ` (burst ${rl.burst})` : '';
  return `${rl.average} req/${rl.period ?? '1s'}${burst}`;
}

export function printRouteDetail(route: GatewayRoute): void {
  const allowIps = route.allowIps?.length
    ? route.allowIps.join(', ')
    : chalk.dim('any');
  const errorSuffix = route.errorMessage
    ? chalk.red(` — ${route.errorMessage}`)
    : '';
  const status = reconciliationLabel(route.reconciliationStatus);

  console.log('');
  console.log(`  ${chalk.bold('Host:')}      ${route.host}`);
  console.log(`  ${chalk.bold('Path:')}      ${route.path}`);
  console.log(`  ${chalk.bold('Service:')}   ${route.service}`);
  console.log(`  ${chalk.bold('TLS:')}       ${tlsLabel(route)}`);
  if (!route.tlsEnabled && route.certificatePhase?.detail) {
    console.log(`             ${chalk.dim(route.certificatePhase.detail)}`);
  }
  console.log(`  ${chalk.bold('Auth:')}      ${authLabel(route)}`);
  console.log(`  ${chalk.bold('RateLimit:')} ${rateLimitLabel(route)}`);
  console.log(`  ${chalk.bold('Allow IPs:')} ${allowIps}`);
  console.log(`  ${chalk.bold('Status:')}    ${status}${errorSuffix}`);
  console.log(`  ${chalk.bold('Route ID:')}  ${chalk.dim(route.endpointId)}`);
  console.log('');
}

export function splitCidrList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseCidrList(value: string): string[] {
  const entries = splitCidrList(value);
  const invalid = entries.filter((e) => !isCidr(e));
  if (invalid.length) {
    throw new Error(
      `${invalid.map((e) => '"' + e + '"').join(', ')} is not a valid IPv4/IPv6 address or CIDR range (e.g. 203.0.113.7 or 203.0.113.0/24)`,
    );
  }
  return entries;
}

function isCidr(value: string): boolean {
  const parts = value.split('/');
  if (parts.length > 2) return false;
  const family = isIP(parts[0]);
  if (!family) return false;
  if (parts.length === 1) return true;
  if (!/^\d{1,3}$/.test(parts[1])) return false;
  return Number(parts[1]) <= (family === 4 ? 32 : 128);
}
