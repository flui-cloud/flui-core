import { AlertEventEntity } from '../entities/alert-event.entity';

export type AlertMailKind = 'fired' | 'resolved';

export type AlertMailAudience = 'owner' | 'admin' | 'destination';

export interface AlertMailContext {
  /** The dashboard this installation serves, when it is known. */
  dashboardUrl?: string | null;
  clusterName?: string | null;
  audience: AlertMailAudience;
}

export interface RenderedAlertMail {
  subject: string;
  text: string;
  html: string;
}

interface Tone {
  label: string;
  color: string;
  tint: string;
}

interface AlertMailContent {
  resolved: boolean;
  tone: Tone;
  installation: string | null;
  logoUrl: string | null;
  headline: string;
  description: string;
  rows: [string, string][];
  action: string | null;
  link: string | null;
  closing: string | null;
  why: string;
}

const SUBJECT_HEADLINE_MAX = 90;

const TONES: Record<string, Tone> = {
  critical: { label: 'Critical', color: '#b42318', tint: '#fef3f2' },
  warning: { label: 'Warning', color: '#b54708', tint: '#fffaeb' },
  info: { label: 'Info', color: '#175cd3', tint: '#eff8ff' },
  resolved: { label: 'Recovered', color: '#067647', tint: '#ecfdf3' },
};

const CLUSTER_TAB_BY_KIND: Record<string, string> = {
  node: 'nodes',
  volume: 'storage',
  certificate: 'dns',
};

/**
 * The installation as a reader recognises it: the dashboard's host, without
 * the `app.` every installer puts in front of its own domain.
 */
export function installationLabel(dashboardUrl?: string | null): string | null {
  if (!dashboardUrl) return null;
  try {
    return new URL(dashboardUrl).host.replace(/^app\./, '');
  } catch {
    return null;
  }
}

/** The dashboard page that answers "what is this about", by what the alert is about. */
export function alertDashboardPath(event: AlertEventEntity): string {
  if (event.applicationId) {
    return `/apps/applications/${event.applicationId}/monitoring`;
  }
  if (event.fluiKind === 'backup') return '/management/backup/overview';
  const scalingGroup = event.labels?.scaling_group_id;
  if (event.fluiKind === 'scaling' && scalingGroup) {
    return `/scaling/${scalingGroup}/now`;
  }
  if (event.clusterId) {
    const tab = CLUSTER_TAB_BY_KIND[event.fluiKind ?? ''] ?? 'overview';
    return `/cluster/${event.clusterId}/${tab}`;
  }
  return '/';
}

/**
 * Mail clients drop inline SVG and data URIs, so the mark is the PNG the
 * installation's own dashboard already serves.
 */
const DASHBOARD_LOGO_PATH = '/icons/logo.png';

function dashboardAsset(
  path: string,
  dashboardUrl?: string | null,
): string | null {
  if (!dashboardUrl) return null;
  try {
    return new URL(path, dashboardUrl).toString();
  } catch {
    return null;
  }
}

export function alertDashboardLink(
  event: AlertEventEntity,
  dashboardUrl?: string | null,
): string | null {
  return dashboardAsset(alertDashboardPath(event), dashboardUrl);
}

function formatTime(date: Date): string {
  const formatted = date.toLocaleString('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${formatted} UTC`;
}

function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  return [days && `${days}d`, hours && `${hours}h`, rest && `${rest}m`]
    .filter(Boolean)
    .join(' ');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

/**
 * "Backup x failed: <provider error>" reads as a headline and a reason; only the
 * headline belongs in a subject line.
 */
function splitReason(summary: string): [string, string | null] {
  const at = summary.indexOf(': ');
  if (at <= 0) return [summary, null];
  return [summary.slice(0, at), summary.slice(at + 2).trim() || null];
}

function toneOf(resolved: boolean, severity: string | null | undefined): Tone {
  if (resolved) return TONES.resolved;
  const known = TONES[(severity ?? '').toLowerCase()];
  return known ?? { ...TONES.info, label: severity || 'Alert' };
}

function why(audience: AlertMailAudience, event: AlertEventEntity): string {
  if (audience === 'owner') {
    const what = event.applicationSlug ?? 'the application it is about';
    return `You are receiving this because you own ${what}.`;
  }
  if (audience === 'destination') {
    return 'You are receiving this because this address is an alert destination of this installation.';
  }
  return 'You are receiving this because you are an administrator of this installation.';
}

function detailRows(
  resolved: boolean,
  event: AlertEventEntity,
  installation: string | null,
  clusterName: string | null | undefined,
): [string, string][] {
  const optional: [string, string | null | undefined][] = [
    ['Installation', installation],
    ['Cluster', clusterName],
    ['Application', event.applicationSlug],
    ['Node', event.nodeInstance],
    ['Backup policy', event.labels?.policy],
    ['Scaling group', event.labels?.scaling_group],
    ['Alert', event.alertname],
    ['Severity', event.severity || 'unknown'],
    ['Since', event.startsAt ? formatTime(event.startsAt) : null],
  ];
  if (resolved && event.endsAt) {
    optional.push(['Recovered', formatTime(event.endsAt)]);
    if (event.startsAt) {
      const lasted = event.endsAt.getTime() - event.startsAt.getTime();
      optional.push(['Lasted', formatDuration(lasted)]);
    }
  }
  return optional.filter((row): row is [string, string] => Boolean(row[1]));
}

function content(
  kind: AlertMailKind,
  event: AlertEventEntity,
  context: AlertMailContext,
): AlertMailContent {
  const resolved = kind === 'resolved';
  const fallback = [
    event.alertname,
    event.applicationSlug ?? event.nodeInstance,
  ]
    .filter(Boolean)
    .join(' on ');
  const [headline, reason] = splitReason(
    event.annotations?.summary ?? fallback,
  );
  const description = [reason, event.annotations?.description]
    .filter((part): part is string => Boolean(part) && part !== headline)
    .join('\n\n');
  const installation = installationLabel(context.dashboardUrl);

  return {
    resolved,
    tone: toneOf(resolved, event.severity),
    installation,
    logoUrl: dashboardAsset(DASHBOARD_LOGO_PATH, context.dashboardUrl),
    headline,
    description,
    rows: detailRows(resolved, event, installation, context.clusterName),
    action: resolved ? null : (event.annotations?.action ?? null),
    link: alertDashboardLink(event, context.dashboardUrl),
    closing: resolved
      ? null
      : 'You will get one more message when it recovers.',
    why: why(context.audience, event),
  };
}

function subjectOf(c: AlertMailContent): string {
  const prefix = c.installation ? `[${c.installation}] ` : '';
  return `${prefix}${c.tone.label}: ${clip(c.headline, SUBJECT_HEADLINE_MAX)}`;
}

function textOf(c: AlertMailContent): string {
  const lines = [c.resolved ? `Recovered: ${c.headline}` : c.headline];
  if (c.description) lines.push('', c.description);
  lines.push('', ...c.rows.map(([k, v]) => `${k.padEnd(14)}${v}`));
  if (c.action) lines.push('', 'To fix it:', `  ${c.action}`);
  if (c.link) lines.push('', `Open in the dashboard: ${c.link}`);
  if (c.closing) lines.push('', c.closing);
  lines.push('', '--', c.why);
  return lines.join('\n');
}

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = 'SFMono-Regular,Menlo,Consolas,monospace';

function cell(style: string, inner: string): string {
  return `<tr><td style="${style}">${inner}</td></tr>`;
}

function htmlOf(c: AlertMailContent): string {
  const e = escapeHtml;
  const name = c.installation ? `Flui · ${e(c.installation)}` : 'Flui';
  const logo = c.logoUrl
    ? `<img src="${e(c.logoUrl)}" width="24" height="24" alt="Flui" style="display:inline-block;width:24px;height:24px;border:0;vertical-align:middle;margin-right:8px">`
    : '';
  const brand = `${logo}<span style="vertical-align:middle">${name}</span>`;
  const rows = c.rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 16px 6px 0;color:#667085;white-space:nowrap;vertical-align:top">${e(k)}</td>` +
        `<td style="padding:6px 0;color:#101828;word-break:break-word">${e(v)}</td></tr>`,
    )
    .join('');
  const badge = `<span style="display:inline-block;padding:2px 10px;border-radius:999px;background:${c.tone.tint};color:${c.tone.color};font-weight:600;font-size:12px">${e(c.tone.label)}</span>`;
  const command = c.action
    ? `<div style="font-weight:600;margin-bottom:6px">To fix it</div><div style="font-family:${MONO};font-size:12px;background:#f9fafb;border:1px solid #eaecf0;border-radius:8px;padding:10px 12px;word-break:break-all">${e(c.action)}</div>`
    : null;
  const button = c.link
    ? `<a href="${e(c.link)}" style="display:inline-block;background:#101828;color:#ffffff;text-decoration:none;font-weight:600;padding:10px 16px;border-radius:8px">Open in the dashboard</a>`
    : null;

  const body = [
    cell('padding:20px 24px 0 24px;color:#667085;font-size:13px', brand),
    cell('padding:12px 24px 0 24px', badge),
    cell(
      'padding:10px 24px 0 24px;font-size:18px;font-weight:600;line-height:1.35',
      e(c.headline),
    ),
    c.description
      ? cell(
          'padding:8px 24px 0 24px;color:#344054;white-space:pre-line',
          e(c.description),
        )
      : '',
    cell(
      'padding:16px 24px 0 24px',
      `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-top:1px solid #eaecf0;font-size:13px">${rows}</table>`,
    ),
    command ? cell('padding:16px 24px 0 24px', command) : '',
    button ? cell('padding:20px 24px 4px 24px', button) : '',
    c.closing
      ? cell('padding:16px 24px 4px 24px;color:#475467', e(c.closing))
      : '',
    cell(
      'padding:16px 24px 20px 24px;color:#98a2b3;font-size:12px;border-top:1px solid #eaecf0',
      e(c.why),
    ),
  ].join('\n');

  const card = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid #eaecf0;border-radius:12px;font-family:${FONT};font-size:14px;line-height:1.5;color:#101828">\n${body}\n</table>`;

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f2f4f7">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f4f7;padding:24px 12px">
<tr><td align="center">
${card}
</td></tr>
</table>
</body></html>`;
}

export function renderAlertMail(
  kind: AlertMailKind,
  event: AlertEventEntity,
  context: AlertMailContext,
): RenderedAlertMail {
  const c = content(kind, event, context);
  return { subject: subjectOf(c), text: textOf(c), html: htmlOf(c) };
}
