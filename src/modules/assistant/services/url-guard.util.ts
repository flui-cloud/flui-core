/**
 * Deterministic guard against fabricated app endpoint URLs. A weak model tends to
 * invent an app's URL — building a plausible hostname under some domain (nip.io,
 * a custom domain, anything) — instead of using a tool result, especially when the
 * app has no endpoint at all. Flui generates endpoints in several modes with no
 * common shape, so detection cannot rely on the URL's format. These pure helpers
 * extract URLs and their hosts; the agent loop decides which hosts are legitimate
 * by checking them against the source of truth (tool results, the user, and the DB).
 */

// Length-bounded to stay linear (no ReDoS); real URLs are far under this.
const URL_RE = /https?:\/\/[^\s<>"'`)\]]{1,2048}/gi;
// Trailing punctuation around a URL, not part of it.
const TRAILING = /[.,;:!?)\]'"]{1,8}$/;

function stripTrailing(url: string): string {
  return url.replace(TRAILING, '');
}

/** http(s) URLs in free text, with trailing punctuation trimmed. */
export function extractUrls(text: string): string[] {
  return (text.match(URL_RE) ?? []).map(stripTrailing);
}

/** Lowercased host of a URL, or null when it does not parse. */
export function hostOf(raw: string): string | null {
  try {
    return new URL(stripTrailing(raw)).host.toLowerCase();
  } catch {
    return null;
  }
}

/** `host` + `path`, lowercased host, no trailing slash, query dropped. */
export function normalizeUrl(raw: string): string | null {
  try {
    const u = new URL(stripTrailing(raw));
    const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
    return `${u.protocol}//${u.host.toLowerCase()}${path}`;
  } catch {
    return null;
  }
}

/** All lowercased hosts appearing in the given texts (tool results, user messages). */
export function collectHosts(texts: string[]): Set<string> {
  const hosts = new Set<string>();
  for (const text of texts) {
    for (const url of extractUrls(text)) {
      const host = hostOf(url);
      if (host) hosts.add(host);
    }
  }
  return hosts;
}

/**
 * URLs in `content` whose host is NOT in `allowedHosts` — i.e. not sourced from a
 * tool/user and not a verified endpoint. Returns the offending URLs as written.
 */
export function findUnverifiedUrls(
  content: string,
  allowedHosts: Set<string>,
): string[] {
  const offenders: string[] = [];
  const seen = new Set<string>();
  for (const url of extractUrls(content)) {
    const host = hostOf(url);
    if (!host) continue;
    if (allowedHosts.has(host)) continue;
    const key = normalizeUrl(url) ?? url;
    if (seen.has(key)) continue;
    seen.add(key);
    offenders.push(url);
  }
  return offenders;
}
