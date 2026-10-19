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

// Hosts the assistant may cite from its knowledge: Flui's documentation and source.
export const DOCUMENTATION_HOSTS: ReadonlySet<string> = new Set([
  'docs.flui.cloud',
  'flui.cloud',
  'www.flui.cloud',
  'github.com',
  'gitlab.com',
]);

const PLACEHOLDER_TLDS = new Set([
  'example',
  'test',
  'invalid',
  'localhost',
  'local',
]);
const PLACEHOLDER_DOMAINS = ['example.com', 'example.org', 'example.net'];
const DOC_IP_PREFIXES = ['127.', '192.0.2.', '198.51.100.', '203.0.113.'];

/**
 * Hosts that read as an illustration rather than a claim about a real
 * endpoint: reserved example domains (RFC 2606/6761), loopback, the
 * documentation IP ranges (RFC 5737) and "your-…" stand-ins.
 */
export function isPlaceholderHost(host: string): boolean {
  const name = host.replace(/:\d+$/, '').replace(/\.$/, '');
  if (name === 'localhost') return true;
  if (DOC_IP_PREFIXES.some((p) => name.startsWith(p))) return true;
  const labels = name.split('.');
  if (PLACEHOLDER_TLDS.has(labels.at(-1) ?? '')) return true;
  if (PLACEHOLDER_DOMAINS.some((d) => name === d || name.endsWith(`.${d}`))) {
    return true;
  }
  return labels.some((l) => /^your[-_]?[a-z]/.test(l));
}

// A URL that runs straight into a template marker (`https://app.<your-domain>`).
const TEMPLATE_FOLLOWER = /^[<{$]/;
const TEMPLATE_IN_HOST = /^https?:\/\/[^/]*[{}$]/i;

function urlMatches(text: string): { url: string; index: number }[] {
  const out: { url: string; index: number }[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const index = m.index ?? 0;
    if (TEMPLATE_FOLLOWER.test(text.slice(index + m[0].length))) continue;
    if (TEMPLATE_IN_HOST.test(m[0])) continue;
    out.push({ url: stripTrailing(m[0]), index });
  }
  return out;
}

/**
 * URLs in `content` whose host is NOT in `allowedHosts` — i.e. not sourced from a
 * tool/user and not a verified endpoint — and is not an obvious placeholder.
 * Returns the offending URLs as written.
 */
export function findUnverifiedUrls(
  content: string,
  allowedHosts: Set<string>,
): string[] {
  const offenders: string[] = [];
  const seen = new Set<string>();
  for (const { url } of urlMatches(content)) {
    const host = hostOf(url);
    if (!host) continue;
    if (allowedHosts.has(host) || isPlaceholderHost(host)) continue;
    const key = normalizeUrl(url) ?? url;
    if (seen.has(key)) continue;
    seen.add(key);
    offenders.push(url);
  }
  return offenders;
}

export const URL_PLACEHOLDER = '<app-url>';

function codeRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  for (const m of text.matchAll(/```[\s\S]*?(?:```|$)|`[^`\n]+`/g)) {
    ranges.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }
  return ranges;
}

/**
 * Removes the given URLs without touching anything else: a markdown link keeps
 * its text, a URL inside code becomes a placeholder the reader can fill in, and
 * a bare URL in prose becomes the same placeholder as inline code.
 */
export function stripUrls(content: string, urls: string[]): string {
  if (!urls.length) return content;
  const targets = new Set(urls);
  let out = content.replace(
    /\[([^\]\n]{1,300})\]\((https?:\/\/[^\s)]{1,2048})\)/g,
    (whole, label: string, url: string) =>
      targets.has(stripTrailing(url)) ? label : whole,
  );
  const ranges = codeRanges(out);
  const inCode = (i: number) => ranges.some(([a, b]) => i >= a && i < b);
  const hits = urlMatches(out)
    .filter((m) => targets.has(m.url))
    .sort((a, b) => b.index - a.index);
  for (const { url, index } of hits) {
    const replacement = inCode(index)
      ? URL_PLACEHOLDER
      : `\`${URL_PLACEHOLDER}\``;
    out = out.slice(0, index) + replacement + out.slice(index + url.length);
  }
  return out;
}
