import { stripTrailingSlashes } from '../../common/utils/url.util';

/**
 * The value `SANDBOX_BASE_DOMAIN` falls back to when nothing sets it.
 *
 * It is a placeholder and not a live name: at the time of writing `try.flui.cloud`
 * has neither a record nor a delegation. Kept as the default because the name is
 * the intention, but every surface that hands it to a visitor has to be able to
 * tell that nobody chose it — hence the export.
 */
export const SANDBOX_PLACEHOLDER_BASE_DOMAIN = 'try.flui.cloud';

/**
 * Where a guest area is opened.
 *
 * `SANDBOX_BASE_DOMAIN` is normally a bare hostname and the scheme is implied,
 * but a local instantiation runs the dashboard on `localhost:4200` over plain
 * HTTP — and prepending `https://` there hands the visitor a link that cannot
 * connect. So a value that already carries a scheme is taken as given.
 */
export function loginUrl(baseDomain: string): string {
  const trimmed = stripTrailingSlashes(baseDomain.trim());
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * The one door into the sandbox, and the only thing any surface outside this
 * instance needs to know about it.
 *
 * There is deliberately a single URL rather than one per entrance: the landing
 * page, a mailed link and an operator pasting a link into a chat must all send a
 * visitor to the same place, and the place is decided by the environment rather
 * than by whoever wrote the link. `/try` is the dashboard route that claims a
 * tenancy and drops the visitor inside it.
 *
 * Claiming lives behind the dashboard rather than on the page that advertises it
 * on purpose: the credential comes back as an httpOnly cookie, and a cookie set
 * on a cross-site fetch from the marketing domain is dropped by the browser
 * unless the whole product's session cookie is loosened to `SameSite=None`.
 * Sending the visitor to the dashboard first makes the claim same-site and costs
 * that loosening nothing.
 */
export function entryUrl(baseDomain: string): string {
  return `${loginUrl(baseDomain)}/try`;
}

/**
 * The link a guest mails themselves.
 *
 * It points at the API rather than at the dashboard: the token has to be turned
 * into an httpOnly cookie, which only the server can set, and the redirect that
 * follows leaves it out of the address bar.
 */
export function resumeLink(baseDomain: string, token: string): string {
  const api = stripTrailingSlashes(process.env.API_BASE_URL || '');
  const base = api || loginUrl(baseDomain);
  return `${base}/api/v1/sandbox/resume?token=${encodeURIComponent(token)}`;
}

export type SandboxEntryVerdict = 'ok' | 'placeholder' | 'local';

export interface SandboxEntryReport {
  verdict: SandboxEntryVerdict;
  entryUrl: string;
  message: string;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

const LOCAL_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '[::1]',
]);

/**
 * What the instance should say about its own front door at boot.
 *
 * Modelled on the `WEBHOOK_BASE_URL` check, and for the same reason: a URL that
 * lives in the environment is wrong silently. A sandbox switched on without
 * `SANDBOX_BASE_DOMAIN` sends every visitor, and every link it mails out, to a
 * name that does not resolve — and nothing about the claim itself fails, so
 * nobody finds out until a stranger clicks.
 *
 * Pure so the wording can be tested without standing up a logger.
 */
export function describeSandboxEntry(baseDomain: string): SandboxEntryReport {
  const url = entryUrl(baseDomain);

  if (baseDomain.trim() === SANDBOX_PLACEHOLDER_BASE_DOMAIN) {
    return {
      verdict: 'placeholder',
      entryUrl: url,
      message:
        `The sandbox is on, but SANDBOX_BASE_DOMAIN is unset, so its door is ${url} — ` +
        'the built-in placeholder, which is not a name this deployment owns. Visitors sent ' +
        'there arrive nowhere and saved links are dead on arrival. Set SANDBOX_BASE_DOMAIN ' +
        'to the origin the dashboard is served from.',
    };
  }

  if (LOCAL_HOSTS.has(hostOf(url))) {
    return {
      verdict: 'local',
      entryUrl: url,
      message:
        `Sandbox door: ${url} (local). Correct for a local instantiation; links mailed ` +
        'from here only open on this machine.',
    };
  }

  return { verdict: 'ok', entryUrl: url, message: `Sandbox door: ${url}` };
}
