/**
 * The JSON the identity provider posts to an HTTP email provider:
 * `{ contextInfo: { recipientEmailAddress, eventType, provider }, templateData:
 * { title, preHeader, subject, greeting, text, url, buttonText, primaryColor,
 * backgroundColor, fontColor, logoUrl, fontFamily, includeFooter, footerText },
 * args: {...} }`. It carries the translated pieces, not a rendered message, so
 * Flui renders it.
 */
export interface IdentityEmailPayload {
  contextInfo?: {
    recipientEmailAddress?: unknown;
    eventType?: unknown;
  };
  templateData?: Record<string, unknown>;
  args?: Record<string, unknown>;
}

export interface IdentityEmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  eventType: string | null;
}

export class IdentityEmailPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityEmailPayloadError';
  }
}

const EMAIL_PART = /^[^\s@<>"',;]+$/;
const COLOR = /^#[0-9a-f]{3,8}$/i;
const BREAK = /<br\s*\/?>/gi;

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#34;': '"',
  '&#39;': "'",
  '&#x27;': "'",
};

function unescapeHtml(value: string): string {
  return value.replace(
    /&(?:amp|lt|gt|quot|#34|#39|#x27);/g,
    (entity) => ENTITIES[entity] ?? entity,
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function isEmail(value: string): boolean {
  const at = value.indexOf('@');
  if (at < 0) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  return (
    EMAIL_PART.test(local) &&
    EMAIL_PART.test(domain) &&
    domain.slice(1, -1).includes('.')
  );
}

function stripTags(value: string): string {
  let out = '';
  let from = 0;
  for (;;) {
    const open = value.indexOf('<', from);
    if (open < 0) break;
    const close = value.indexOf('>', open);
    if (close < 0) break;
    out += value.slice(from, open);
    from = close + 1;
  }
  return out + value.slice(from);
}

function str(value: unknown): string {
  return typeof value === 'string' ? unescapeHtml(value).trim() : '';
}

function plain(value: string): string {
  return stripTags(value.replace(BREAK, '\n')).trim();
}

function rich(value: string): string {
  return plain(value)
    .split('\n')
    .map((line) => escapeHtml(line))
    .join('<br>');
}

function httpUrl(value: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function parseIdentityEmail(body: unknown): IdentityEmailMessage {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new IdentityEmailPayloadError('The message is not a JSON object.');
  }
  const payload = body as IdentityEmailPayload;
  const to = str(payload.contextInfo?.recipientEmailAddress).toLowerCase();
  if (!isEmail(to)) {
    throw new IdentityEmailPayloadError('The message names no recipient.');
  }
  const data = payload.templateData ?? {};
  const subject = plain(str(data.subject) || str(data.title));
  if (!subject) {
    throw new IdentityEmailPayloadError('The message has no subject.');
  }

  const greeting = str(data.greeting);
  const text = str(data.text);
  const url = httpUrl(str(data.url));
  const buttonText = plain(str(data.buttonText));
  const footer = data.includeFooter === true ? str(data.footerText) : '';
  const eventType = str(payload.contextInfo?.eventType) || null;

  const textBody = [
    plain(greeting),
    plain(text),
    url ? `${buttonText || 'Open'}: ${url}` : '',
    plain(footer),
  ]
    .filter(Boolean)
    .join('\n\n');

  const primary = COLOR.test(str(data.primaryColor))
    ? str(data.primaryColor)
    : '#5282C1';
  const fontColor = COLOR.test(str(data.fontColor))
    ? str(data.fontColor)
    : '#22292f';
  const background = COLOR.test(str(data.backgroundColor))
    ? str(data.backgroundColor)
    : '#fafafa';

  const html = [
    `<!doctype html><html><body style="margin:0;padding:24px;background:${background};color:${fontColor};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">`,
    `<div style="max-width:560px;margin:0 auto;">`,
    greeting ? `<p>${rich(greeting)}</p>` : '',
    text ? `<p>${rich(text)}</p>` : '',
    url
      ? `<p><a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 18px;border-radius:6px;background:${primary};color:#ffffff;text-decoration:none;">${escapeHtml(buttonText || 'Open')}</a></p>` +
        `<p style="font-size:12px;word-break:break-all;">${escapeHtml(url)}</p>`
      : '',
    footer ? `<p style="font-size:12px;">${rich(footer)}</p>` : '',
    `</div></body></html>`,
  ].join('');

  return { to, subject, text: textBody, html, eventType };
}
