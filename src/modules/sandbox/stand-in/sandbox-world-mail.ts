/**
 * The Mail half of the example world.
 *
 * Mail is the clearest case in the whole sandbox for a stand-in rather than a
 * projection: the real content of this section is recipient addresses, which
 * are other people's personal data, and no projection of "everyone the instance
 * has written to" is safe to show. So the section is answered from here — a
 * connection that sends for the example organisation, a week of its traffic,
 * and the delivery proofs on its own domain.
 *
 * Recipients are on reserved domains (RFC 2606), the same reasoning as the
 * RFC 5737 addresses on the example machines: they are shaped like real
 * addresses and belong to nobody. The credential is *declared* and never shown,
 * not even invented — see the header of `sandbox-world.ts`.
 */
import {
  APPS,
  daysAgo,
  hoursAgo,
  mark,
  minutesAgo,
  ORG_NAME,
  SandboxStandInQuery,
  ZONE_NAME,
} from './sandbox-world-core';

const CONNECTION_ID = 'example-mail-connection-1';
const PROVIDER_ID = 'scaleway-tem';
const SENDER = `orders@${ZONE_NAME}`;

const RECIPIENTS = [
  'ana.ferreira@example.com',
  'l.moreau@example.net',
  'k.svensson@example.org',
  'p.novak@example.com',
  'h.duarte@example.net',
] as const;

const kpi = (
  id: string,
  count: number,
  rate: number | null,
  previousCount: number,
  previousRate: number | null,
  tone: string,
) =>
  mark({
    id,
    count,
    rate,
    previousCount,
    previousRate,
    delta:
      rate !== null && previousRate !== null
        ? Number((rate - previousRate).toFixed(4))
        : null,
    tone,
  });

/**
 * A day's traffic, shaped by hand so the chart has something to say rather than
 * a flat line. The window the caller asks for decides how many of these days
 * are shown, and how they are bucketed — a section that answers the same seven
 * days whatever the control says is caught in the lie by the first person who
 * changes it.
 */
const DAY_SHAPE = [
  812, 774, 903, 1120, 1047, 688, 742, 869, 951, 1004, 726, 798, 1132, 880, 690,
  745, 913, 1076, 995, 812, 767, 884, 1041, 930, 705, 771, 926, 1088, 973, 845,
] as const;

const WINDOWS: Record<string, { days: number; bucket: 'hour' | 'day' }> = {
  '24h': { days: 1, bucket: 'hour' },
  '7d': { days: 7, bucket: 'day' },
  '14d': { days: 14, bucket: 'day' },
  '30d': { days: 30, bucket: 'day' },
};

const failuresFor = (delivered: number) =>
  Math.max(2, Math.round(delivered / 110));

function windowFrom(query: SandboxStandInQuery) {
  const asked = typeof query.window === 'string' ? query.window : '7d';
  const name = WINDOWS[asked] ? asked : '7d';
  return { name, ...WINDOWS[name] };
}

/** One point per bucket, ending now — the shape repeats, the dates do not. */
function volumeFor(now: number, days: number, bucket: 'hour' | 'day') {
  const points = bucket === 'hour' ? 24 : days;
  return Array.from({ length: points }, (_, index) => {
    const delivered =
      bucket === 'hour'
        ? Math.round(DAY_SHAPE[index % DAY_SHAPE.length] / 24)
        : DAY_SHAPE[index % DAY_SHAPE.length];
    const failed = failuresFor(delivered);
    const at =
      bucket === 'hour'
        ? hoursAgo(now, points - index)
        : daysAgo(now, points - index);
    return { at, delivered, failed, pending: index === points - 1 ? 2 : 0 };
  });
}

export function exampleMailOverview(
  now: number,
  query: SandboxStandInQuery = {},
) {
  const asked = windowFrom(query);
  const volume = volumeFor(now, asked.days, asked.bucket);
  const sent = volume.reduce((t, d) => t + d.delivered + d.failed, 0);
  const delivered = volume.reduce((t, d) => t + d.delivered, 0);
  const failed = volume.reduce((t, d) => t + d.failed, 0);
  // The period before this one, so the deltas on the tiles mean something.
  const previousSent = Math.round(sent * 0.96);
  const previousDelivered = Math.round(previousSent * 0.9895);

  return mark({
    provider: PROVIDER_ID,
    window: {
      from: volume[0].at,
      to: new Date(now).toISOString(),
      name: asked.name,
    },
    bucket: asked.bucket,
    incident: null,
    kpis: [
      kpi('sent', sent, null, previousSent, null, 'neutral'),
      kpi(
        'delivered',
        delivered,
        Number((delivered / sent).toFixed(4)),
        previousDelivered,
        0.9895,
        'neutral',
      ),
      kpi(
        'bounced',
        failed,
        Number((failed / sent).toFixed(4)),
        previousSent - previousDelivered,
        0.0105,
        'neutral',
      ),
      kpi('complained', 1, Number((1 / sent).toFixed(5)), 2, 0.0003, 'neutral'),
    ],
    volume: volume.map((point) => mark(point)),
    domains: [exampleDomainSummary(sent)],
    senders: [
      mark({
        from: SENDER,
        domain: ZONE_NAME,
        application: {
          applicationId: APPS[1].id,
          applicationName: APPS[1].name,
          address: SENDER,
        },
        sent,
        delivered,
        failed,
        deliveredRate: Number((delivered / sent).toFixed(4)),
        lastError: 'mailbox unavailable',
        lastErrorAt: hoursAgo(now, 19),
        lastSentAt: minutesAgo(now, 6),
        lastDeliveredAt: minutesAgo(now, 6),
        status: 'delivering',
      }),
    ],
    unregisteredDomains: [],
  });
}

const exampleDomainSummary = (sent: number) =>
  mark({
    domain: ZONE_NAME,
    spf: 'ok',
    dkim: 'ok',
    dmarc: 'ok',
    verified: true,
    sent,
  });

export function exampleMailConnections(now: number) {
  return [
    mark({
      id: CONNECTION_ID,
      provider: PROVIDER_ID,
      scope: 'transactional',
      label: `${ORG_NAME} transactional`,
      sendingDomain: ZONE_NAME,
      isActive: true,
      // Says the credential exists. Its value is never shown, and no invented
      // one is put in its place: a fake key is still a string shaped like a key.
      hasCredential: true,
      webhookRegistered: true,
      implicit: false,
      createdAt: daysAgo(now, 23),
    }),
  ];
}

export function exampleMailDomains() {
  return [
    mark({
      domain: ZONE_NAME,
      spf: 'ok',
      dkim: 'ok',
      dmarc: 'ok',
      verified: true,
      provider: PROVIDER_ID,
      scope: 'transactional',
      active: true,
      connectionId: CONNECTION_ID,
    }),
  ];
}

export function exampleMailReadiness() {
  return mark({
    provider: PROVIDER_ID,
    ready: true,
    projectId: null,
    steps: ['credential', 'domain', 'dns', 'verification'].map((id) =>
      mark({ id, status: 'satisfied' }),
    ),
  });
}

/**
 * A recent slice of delivery, including the failures — a mail section where
 * nothing ever bounces teaches nothing about what the section is for.
 */
export function exampleMailEvents(now: number) {
  const events: Array<{
    kind: string;
    minutes: number;
    recipient: string;
    reason?: string;
    code?: number;
  }> = [
    { kind: 'delivered', minutes: 6, recipient: RECIPIENTS[0] },
    { kind: 'delivered', minutes: 41, recipient: RECIPIENTS[1] },
    { kind: 'delivered', minutes: 96, recipient: RECIPIENTS[2] },
    {
      kind: 'bounced',
      minutes: 1_140,
      recipient: RECIPIENTS[3],
      reason: 'mailbox unavailable',
      code: 550,
    },
    { kind: 'delivered', minutes: 1_390, recipient: RECIPIENTS[4] },
    {
      kind: 'deferred',
      minutes: 1_620,
      recipient: RECIPIENTS[1],
      reason: 'greylisted, will retry',
      code: 451,
    },
  ];

  return events.map((event, index) =>
    mark({
      kind: event.kind,
      provider: PROVIDER_ID,
      messageId: `example-message-${index + 1}`,
      recipient: event.recipient,
      from: SENDER,
      at: minutesAgo(now, event.minutes),
      subject: 'Your order has shipped',
      ...(event.reason ? { reason: event.reason } : {}),
      ...(event.code ? { code: event.code } : {}),
    }),
  );
}

export function exampleMailSuppressions(now: number) {
  return [
    mark({
      address: RECIPIENTS[3],
      reason: 'bounce',
      scope: 'all',
      at: hoursAgo(now, 19),
      source: PROVIDER_ID,
      detail: 'Hard bounce: mailbox unavailable (550)',
    }),
  ];
}

/**
 * What the setup screen shows for the example connection: the proofs published
 * on the sending domain, all satisfied.
 *
 * SPF and DMARC carry their real, published text — they are policies, not
 * secrets, and a made-up one would teach the wrong syntax. The DKIM record says
 * that a key is published and stops there: its public half is public, but a long
 * base64 blob on a screen is indistinguishable from a leaked one, and the rule
 * for this whole world is that nothing key-shaped is ever invented.
 */
export function exampleMailConnectionSetup() {
  return mark({
    domain: ZONE_NAME,
    readiness: exampleMailReadiness(),
    records: [
      mark({
        name: ZONE_NAME,
        kind: 'TXT',
        value: 'v=spf1 include:_spf.tem.scw.cloud -all',
        purpose: 'spf',
        live: true,
        accepted: true,
      }),
      mark({
        name: `_dmarc.${ZONE_NAME}`,
        kind: 'TXT',
        value: `v=DMARC1; p=quarantine; rua=mailto:dmarc@${ZONE_NAME}`,
        purpose: 'dmarc',
        live: true,
        accepted: true,
      }),
      mark({
        name: `scw._domainkey.${ZONE_NAME}`,
        kind: 'TXT',
        value: 'v=DKIM1; k=rsa; p=(published)',
        purpose: 'dkim',
        live: true,
        accepted: true,
      }),
    ],
    verified: true,
    ownershipVerified: true,
    published: true,
    // Nothing here is the guest's to publish.
    canWrite: false,
  });
}
