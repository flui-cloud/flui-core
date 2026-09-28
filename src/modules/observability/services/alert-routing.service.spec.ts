jest.mock('../../mail/services/mail-send.service', () => ({
  MailSendService: class MailSendService {},
}));

jest.mock('../../../common/net/egress-guard', () => {
  const actual = jest.requireActual('../../../common/net/egress-guard');
  return { ...actual, guardedRequest: jest.fn() };
});

jest.mock('axios', () => {
  const request = jest.fn();
  return { __esModule: true, default: { request }, request };
});

import axios from 'axios';
import { createHmac, randomBytes } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { guardedRequest } from '../../../common/net/egress-guard';
import { AlertRoutingService } from './alert-routing.service';
import { AlertEventEntity } from '../entities/alert-event.entity';
import { AlertDestinationEntity } from '../entities/alert-destination.entity';
import { UserEventsGateway } from '../../auth/gateway/user-events.gateway';
import { assertWebhookTarget, meetsFloor } from './alert-routing.util';

const posted = guardedRequest as jest.Mock;
const SIGNING_KEY = randomBytes(16).toString('hex');

const event = (over: Partial<AlertEventEntity> = {}): AlertEventEntity =>
  ({
    id: 'e1',
    fingerprint: 'fp1',
    alertname: 'FluiNodeDown',
    severity: 'critical',
    status: 'firing',
    startsAt: new Date('2026-09-01T00:00:00Z'),
    endsAt: null,
    applicationId: null,
    applicationSlug: null,
    nodeInstance: 'node-1',
    annotations: { summary: 'node-1 is not reporting', description: 'd' },
    labels: {},
    ...over,
  }) as AlertEventEntity;

const destination = (
  over: Partial<AlertDestinationEntity> = {},
): AlertDestinationEntity =>
  ({
    id: 'd1',
    kind: 'webhook',
    target: 'https://hooks.example.com/flui',
    minSeverity: 'warning',
    scope: 'infrastructure',
    secretEncrypted: `enc:${SIGNING_KEY}`,
    enabled: true,
    createdBy: 'ops@example.com',
    createdAt: new Date(),
    lastDeliveryAt: null,
    lastStatus: null,
    lastError: null,
    ...over,
  }) as AlertDestinationEntity;

function build(
  rows: AlertDestinationEntity[] = [],
  env: Record<string, string> = {},
) {
  const emitAlert = jest.fn();
  const gateway = { emitAlert } as unknown as UserEventsGateway;
  const moduleRef = { get: jest.fn().mockReturnValue(gateway) };
  const users = {
    find: jest.fn().mockResolvedValue([{ id: 'admin-1' }, { id: 'admin-2' }]),
  };
  const destinations = {
    find: jest.fn().mockResolvedValue(rows),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const mail = {
    deliver: jest.fn().mockResolvedValue(true),
    sendTo: jest.fn().mockResolvedValue({ sent: true }),
  };
  const encryption = {
    decrypt: jest.fn((v: string) => v.replace(/^enc:/, '')),
  };
  const config = { get: (key: string) => env[key] };
  const service = new AlertRoutingService(
    config as never,
    destinations as never,
    users as never,
    mail as never,
    encryption as never,
    moduleRef as never,
  );
  return { service, emitAlert, users, destinations, mail };
}

beforeEach(() => {
  posted.mockReset();
  (axios.request as jest.Mock).mockReset();
});

describe('AlertRoutingService — the bell', () => {
  it('rings the owner of an application alert, and nobody else', async () => {
    const { service, emitAlert } = build();
    await service.deliver(
      'fired',
      event({ applicationId: 'a1', applicationSlug: 'shop' }),
      { ownerUserId: 'owner-1' },
    );
    expect(emitAlert.mock.calls.map((c) => c[0])).toEqual(['owner-1']);
  });

  it('rings every administrator for an alert nobody owns', async () => {
    const { service, emitAlert } = build();
    await service.deliver('fired', event(), { ownerUserId: null });
    expect(emitAlert.mock.calls.map((c) => c[0])).toEqual([
      'admin-1',
      'admin-2',
    ]);
    expect(emitAlert.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        kind: 'fired',
        alertname: 'FluiNodeDown',
        applicationId: null,
      }),
    );
  });
});

describe('AlertRoutingService — email', () => {
  it('keeps the built-in email, with warnings to administrators off by default', async () => {
    const { service, mail } = build();
    await service.deliver('fired', event(), { ownerUserId: null });
    expect(mail.deliver).toHaveBeenCalledWith('fired', expect.anything(), {
      ownerUserId: null,
      adminWarnings: false,
    });
  });

  it('passes the administrators warning switch through when it is on', async () => {
    const { service, mail } = build([
      destination({ kind: 'admins', target: null, minSeverity: 'warning' }),
    ]);
    await service.deliver('fired', event({ severity: 'warning' }), {});
    expect(mail.deliver.mock.calls[0][2]).toEqual({
      ownerUserId: null,
      adminWarnings: true,
    });
  });

  it('sends to an added address only at or above its floor', async () => {
    const { service, mail } = build([
      destination({
        id: 'm1',
        kind: 'email',
        target: 'oncall@example.com',
        minSeverity: 'critical',
        secretEncrypted: null,
      }),
    ]);
    await service.deliver('fired', event({ severity: 'warning' }), {});
    expect(mail.sendTo).not.toHaveBeenCalled();

    await service.deliver('fired', event({ severity: 'critical' }), {});
    expect(mail.sendTo).toHaveBeenCalledWith('fired', expect.anything(), [
      'oncall@example.com',
    ]);
  });
});

describe('AlertRoutingService — webhooks', () => {
  it('filters by severity: info never, warning only when the floor allows it', () => {
    expect(meetsFloor('info', 'warning')).toBe(false);
    expect(meetsFloor('warning', 'warning')).toBe(true);
    expect(meetsFloor('warning', 'critical')).toBe(false);
    expect(meetsFloor('CRITICAL', 'critical')).toBe(true);
    expect(meetsFloor(undefined, 'warning')).toBe(false);
  });

  it('signs the body so the receiver can verify it with the secret', async () => {
    posted.mockResolvedValue({ status: 204 });
    const { service, destinations } = build([destination()], {
      FRONTEND_URL: 'https://flui.example.com',
    });

    await service.deliver('fired', event({ severity: 'warning' }), {});

    expect(posted).toHaveBeenCalledTimes(1);
    const request = posted.mock.calls[0][0];
    const timestamp = request.headers['X-Flui-Timestamp'];
    const expected = createHmac('sha256', SIGNING_KEY)
      .update(`${timestamp}.${request.data}`)
      .digest('hex');
    expect(request.headers['X-Flui-Signature']).toBe(`sha256=${expected}`);
    expect(request.timeout).toBe(5000);
    expect(JSON.parse(request.data)).toEqual({
      alert: 'FluiNodeDown',
      severity: 'warning',
      state: 'firing',
      summary: 'node-1 is not reporting',
      description: 'd',
      application: null,
      node: 'node-1',
      startsAt: '2026-09-01T00:00:00.000Z',
      installation: 'https://flui.example.com',
    });
    expect(destinations.update).toHaveBeenCalledWith(
      'd1',
      expect.objectContaining({ lastStatus: '204', lastError: null }),
    );
  });

  it('gives every delivery its own id, so a receiver can drop a replay', async () => {
    posted.mockResolvedValue({ status: 204 });
    const { service } = build([destination()]);
    await service.deliver('fired', event(), {});
    await service.deliver('fired', event(), {});
    const ids = posted.mock.calls.map((c) => c[0].headers['X-Flui-Delivery']);
    expect(ids[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(ids[1]).not.toBe(ids[0]);
  });

  it('keeps an infrastructure destination to what no application owns', async () => {
    posted.mockResolvedValue({ status: 204 });
    const { service } = build([
      destination({ id: 'infra', scope: 'infrastructure' }),
      destination({ id: 'all', scope: 'all' }),
    ]);
    const reached = () =>
      posted.mock.calls.map((c) => c[0].url as string).length;

    await service.deliver('fired', event(), { ownerUserId: null });
    expect(reached()).toBe(2);

    posted.mockClear();
    await service.deliver(
      'fired',
      event({ applicationId: 'a1', applicationSlug: 'shop' }),
      { ownerUserId: 'owner-1' },
    );
    expect(reached()).toBe(1);

    // A tenant's own backup policy failing carries no application, but it has
    // an owner: it is that tenant's news, not the machine room's.
    posted.mockClear();
    await service.deliver('fired', event({ alertname: 'FluiBackupFailed' }), {
      ownerUserId: 'owner-1',
    });
    expect(reached()).toBe(1);
  });

  it('never posts over plain http to a host nobody allowed, whatever the old flag says', async () => {
    const { service, destinations } = build(
      [destination({ target: 'http://hooks.example.com/flui' })],
      { ALERT_WEBHOOK_ALLOW_PRIVATE: 'true' },
    );
    await service.deliver('fired', event(), {});
    expect(posted).not.toHaveBeenCalled();
    expect(axios.request).not.toHaveBeenCalled();
    expect(destinations.update).toHaveBeenCalledWith(
      'd1',
      expect.objectContaining({
        lastStatus: 'failed',
        lastError: expect.stringContaining('FLUI_EGRESS_ALLOWED_HOSTS'),
      }),
    );
  });

  it('posts over http to an allowed host, still through the guard', async () => {
    posted.mockResolvedValue({ status: 200 });
    const previous = process.env.FLUI_EGRESS_ALLOWED_HOSTS;
    process.env.FLUI_EGRESS_ALLOWED_HOSTS = 'bridge.ops.svc';
    try {
      const { service } = build([
        destination({ target: 'http://bridge.ops.svc:8080/x' }),
      ]);
      await service.deliver('fired', event(), {});
    } finally {
      if (previous === undefined) delete process.env.FLUI_EGRESS_ALLOWED_HOSTS;
      else process.env.FLUI_EGRESS_ALLOWED_HOSTS = previous;
    }
    expect(posted).toHaveBeenCalledTimes(1);
    expect(posted.mock.calls[0][1]).toEqual({
      allowedHosts: ['bridge.ops.svc'],
    });
    expect(axios.request).not.toHaveBeenCalled();
  });

  it('says resolved, with when it ended', async () => {
    posted.mockResolvedValue({ status: 200 });
    const { service } = build([destination()]);
    await service.deliver(
      'resolved',
      event({ endsAt: new Date('2026-09-01T01:00:00Z') }),
      {},
    );
    const body = JSON.parse(posted.mock.calls[0][0].data);
    expect(body.state).toBe('resolved');
    expect(body.endsAt).toBe('2026-09-01T01:00:00.000Z');
  });

  it('never throws when a destination fails, and records why', async () => {
    posted.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const { service, destinations, emitAlert } = build([destination()]);
    await expect(
      service.deliver('fired', event(), { ownerUserId: null }),
    ).resolves.toBeUndefined();
    expect(emitAlert).toHaveBeenCalled();
    expect(destinations.update).toHaveBeenCalledWith(
      'd1',
      expect.objectContaining({
        lastStatus: 'failed',
        lastError: 'connect ECONNREFUSED',
      }),
    );
  });

  it('never throws when the destinations cannot even be read', async () => {
    const { service, destinations, mail } = build();
    destinations.find.mockRejectedValue(new Error('db down'));
    await expect(
      service.deliver('fired', event(), {}),
    ).resolves.toBeUndefined();
    expect(mail.deliver).toHaveBeenCalled();
  });

  it('records a refusal from the receiver as a failure with its status', async () => {
    posted.mockResolvedValue({ status: 500 });
    const { service, destinations } = build([destination()]);
    await service.deliver('fired', event(), {});
    expect(destinations.update).toHaveBeenCalledWith(
      'd1',
      expect.objectContaining({ lastStatus: '500', lastError: 'HTTP 500' }),
    );
  });
});

describe('assertWebhookTarget — no posting into the installation', () => {
  const publicDns = async () => ['93.184.216.34'];

  it.each([
    ['http://hooks.example.com/x', 'https'],
    ['https://127.0.0.1/x', 'loopback'],
    ['https://10.0.0.5/x', 'private network'],
    ['https://169.254.169.254/latest', 'link-local'],
    ['https://[::1]/x', 'loopback'],
    ['https://localhost:8080/x', 'own network'],
    ['https://flui-api.flui-system.svc/x', 'own network'],
    ['https://user:pw@hooks.example.com/x', 'credentials'],
    ['not a url', 'valid URL'],
  ])('refuses %s', async (url, why) => {
    const refusal = assertWebhookTarget(url, {}, publicDns);
    await expect(refusal).rejects.toBeInstanceOf(BadRequestException);
    await expect(refusal).rejects.toThrow(why);
  });

  it('refuses a public name that resolves to a private address', async () => {
    await expect(
      assertWebhookTarget('https://rebind.example.com/x', {}, async () => [
        '93.184.216.34',
        '192.168.1.10',
      ]),
    ).rejects.toThrow('private network');
  });

  it('accepts a public https address', async () => {
    await expect(
      assertWebhookTarget('https://hooks.example.com/x', {}, publicDns),
    ).resolves.toBeInstanceOf(URL);
  });

  it('reaches its own network only through a host the installation allowed', async () => {
    const policy = { allowedHosts: ['alert-bridge.ops.svc'] };
    const inCluster = async () => ['10.43.0.12'];
    await expect(
      assertWebhookTarget(
        'http://alert-bridge.ops.svc:8080/x',
        policy,
        inCluster,
      ),
    ).resolves.toBeInstanceOf(URL);
    await expect(
      assertWebhookTarget('http://other.ops.svc:8080/x', policy, inCluster),
    ).rejects.toThrow('https');
    await expect(
      assertWebhookTarget('https://other.ops.svc:8080/x', policy, inCluster),
    ).rejects.toThrow('own network');
  });

  it('refuses link-local even for an allowed host', async () => {
    await expect(
      assertWebhookTarget(
        'http://metadata.ops.svc/x',
        { allowedHosts: ['metadata.ops.svc'] },
        async () => ['169.254.169.254'],
      ),
    ).rejects.toThrow('link-local');
    await expect(
      assertWebhookTarget('http://169.254.169.254/x', {
        allowedHosts: ['169.254.169.254'],
      }),
    ).rejects.toThrow('link-local');
  });
});
