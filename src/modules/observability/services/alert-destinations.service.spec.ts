jest.mock('../../mail/services/mail-send.service', () => ({
  MailSendService: class MailSendService {},
}));

import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  AlertDestinationsService,
  TEST_ALERT,
} from './alert-destinations.service';
import { AlertDestinationEntity } from '../entities/alert-destination.entity';

const operator = { userId: 'u1', email: 'ops@example.com' } as never;

function build(
  options: { allowedHosts?: string[]; dataAccess?: boolean } = {},
) {
  const rows: AlertDestinationEntity[] = [];
  const repo = {
    create: (v: Partial<AlertDestinationEntity>) => ({ ...v }),
    save: jest.fn(async (v: AlertDestinationEntity) => {
      if (!v.id) {
        Object.assign(v, { id: `d${rows.length + 1}`, createdAt: new Date() });
        rows.push(v);
      }
      return v;
    }),
    find: jest.fn(async () =>
      rows.filter((r) => r.kind === 'email' || r.kind === 'webhook'),
    ),
    findOne: jest.fn(
      async ({ where }: { where: Partial<AlertDestinationEntity> }) =>
        rows.find((r) =>
          where.id ? r.id === where.id : r.kind === where.kind,
        ) ?? null,
    ),
    remove: jest.fn(),
  };
  const encryption = {
    encrypt: jest.fn((v: string) => `sealed:${v}`),
  };
  const routing = {
    sendTo: jest
      .fn()
      .mockResolvedValue({ ok: true, status: '200', error: null }),
  };
  const policy = {
    check: jest.fn().mockResolvedValue(options.dataAccess ?? false),
  };
  const service = new AlertDestinationsService(
    repo as never,
    encryption as never,
    routing as never,
    policy as never,
  );
  Object.assign(service, {
    resolve: async (host: string) =>
      host.endsWith('.svc') ? ['10.43.0.10'] : ['93.184.216.34'],
    egress: () => ({ allowedHosts: options.allowedHosts ?? [] }),
  });
  return { service, rows, repo, routing, encryption, policy };
}

describe('AlertDestinationsService', () => {
  it('returns a webhook secret once, stores it sealed, and never lists it', async () => {
    const { service, rows } = build();
    const created = await service.create(
      {
        kind: 'webhook',
        target: 'https://hooks.example.com/flui',
        minSeverity: 'warning',
      },
      'ops@example.com',
    );

    expect(created.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(created.signed).toBe(true);
    expect(rows[0].secretEncrypted).toBe(`sealed:${created.secret}`);

    const listed = await service.list();
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(created.secret as string);
    expect(listed[0]).not.toHaveProperty('secret');
    expect(listed[0]).not.toHaveProperty('secretEncrypted');
    expect(listed[0]).toEqual(
      expect.objectContaining({
        kind: 'webhook',
        minSeverity: 'warning',
        createdBy: 'ops@example.com',
      }),
    );
  });

  it('gives an email destination no secret and a critical floor by default', async () => {
    const { service } = build();
    const created = await service.create(
      { kind: 'email', target: ' oncall@example.com ' },
      null,
    );
    expect(created).toEqual(
      expect.objectContaining({
        target: 'oncall@example.com',
        minSeverity: 'critical',
        secret: null,
        signed: false,
      }),
    );
  });

  it('refuses an address that is not one', async () => {
    const { service } = build();
    await expect(
      service.create({ kind: 'email', target: 'not-an-address' }, null),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a webhook into the installation’s own network, and saves nothing', async () => {
    const { service, repo } = build();
    await expect(
      service.create({ kind: 'webhook', target: 'https://10.43.0.10/x' }, null),
    ).rejects.toThrow('private network');
    await expect(
      service.create(
        { kind: 'webhook', target: 'http://hooks.example.com' },
        null,
      ),
    ).rejects.toThrow('https');
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('accepts plain http only to a host the installation allowed', async () => {
    const { service } = build({ allowedHosts: ['bridge.ops.svc'] });
    const created = await service.create(
      { kind: 'webhook', target: 'http://bridge.ops.svc:8080/x' },
      null,
    );
    expect(created.secret).toBeTruthy();
    await expect(
      service.create(
        { kind: 'webhook', target: 'http://other.ops.svc:8080/x' },
        null,
      ),
    ).rejects.toThrow('https');
  });

  describe('what a destination hears', () => {
    it('hears infrastructure alerts unless asked otherwise', async () => {
      const { service, policy } = build();
      const created = await service.create(
        { kind: 'email', target: 'oncall@example.com' },
        'ops@example.com',
        operator,
      );
      expect(created.scope).toBe('infrastructure');
      expect((await service.list())[0].scope).toBe('infrastructure');
      expect(policy.check).not.toHaveBeenCalled();
    });

    it('refuses every application’s alerts to someone without data access', async () => {
      const { service, repo, policy } = build({ dataAccess: false });
      const refusal = service.create(
        { kind: 'email', target: 'oncall@example.com', scope: 'all' },
        'ops@example.com',
        operator,
      );
      await expect(refusal).rejects.toBeInstanceOf(ForbiddenException);
      await expect(refusal).rejects.toThrow('data:access');
      expect(policy.check).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u1' }),
        'data:access',
      );
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('lets someone with data access send every alert there', async () => {
      const { service } = build({ dataAccess: true });
      const created = await service.create(
        { kind: 'email', target: 'oncall@example.com', scope: 'all' },
        'ops@example.com',
        operator,
      );
      expect(created.scope).toBe('all');
    });

    it('holds a credential to its ceiling even when the person could', async () => {
      const { service } = build({ dataAccess: true });
      await expect(
        service.create(
          { kind: 'email', target: 'oncall@example.com', scope: 'all' },
          'ops@example.com',
          { userId: 'u1', scopes: ['mcp:not-a-scope'] } as never,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('asks the same question when a destination is widened later', async () => {
      const { service } = build({ dataAccess: false });
      const created = await service.create(
        { kind: 'email', target: 'oncall@example.com' },
        null,
        operator,
      );
      await expect(
        service.update(created.id, { scope: 'all' }, operator),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.update(created.id, { scope: 'infrastructure' }, operator),
      ).resolves.toEqual(expect.objectContaining({ scope: 'infrastructure' }));
    });
  });

  it('tests one destination with a synthetic alert and returns the outcome', async () => {
    const { service, routing } = build();
    const created = await service.create(
      { kind: 'email', target: 'oncall@example.com' },
      null,
    );
    const outcome = await service.test(created.id);
    expect(outcome).toEqual({ ok: true, status: '200', error: null });
    expect(routing.sendTo.mock.calls[0][1]).toBe('fired');
    expect(routing.sendTo.mock.calls[0][2].alertname).toBe(TEST_ALERT);
  });

  it('keeps administrator warnings off until switched on', async () => {
    const { service } = build();
    expect(await service.adminWarnings()).toBe(false);
    await service.setAdminWarnings(true, 'ops@example.com');
    expect(await service.adminWarnings()).toBe(true);
    await service.setAdminWarnings(false, 'ops@example.com');
    expect(await service.adminWarnings()).toBe(false);
  });

  it('survives two requests creating the administrators row at once', async () => {
    const { service, rows, repo } = build();
    const winner = {
      id: 'admins-1',
      kind: 'admins',
      target: null,
      enabled: true,
      minSeverity: 'critical',
    } as AlertDestinationEntity;
    repo.save.mockImplementationOnce(async () => {
      rows.push(winner);
      throw { code: '23505' };
    });

    await expect(
      service.setAdminWarnings(true, 'ops@example.com'),
    ).resolves.toBe(true);
    expect(rows.filter((r) => r.kind === 'admins')).toHaveLength(1);
    expect(winner.minSeverity).toBe('warning');
  });

  it('does not treat the administrators row as a destination', async () => {
    const { service, rows } = build();
    await service.setAdminWarnings(true, null);
    expect(await service.list()).toEqual([]);
    await expect(service.remove(rows[0].id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
