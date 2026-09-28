jest.mock('@kubernetes/client-node', () => ({}));

import { GrantNoticeService, sentenceFor } from './grant-notice.service';
import { UserEventsGateway } from '../../auth/gateway/user-events.gateway';
import { MailSendService } from '../../mail/services/mail-send.service';
import { IamRoleBindingEntity } from '../entities/iam-role-binding.entity';

const NOW = new Date('2026-09-28T10:00:00Z');
const HOUR = 3_600_000;

function grant(over: Partial<IamRoleBindingEntity>): IamRoleBindingEntity {
  return {
    id: 'g1',
    principalType: 'user',
    principalRef: 'op@support.example',
    role: 'platform_operator',
    scopeType: 'global',
    scopeRef: null,
    selector: null,
    createdAt: new Date(NOW.getTime() - 6 * 24 * HOUR),
    expiresAt: new Date(NOW.getTime() + 12 * HOUR),
    grantedBy: 'owner@customer.example',
    expiringNoticeAt: null,
    expiredNoticeAt: null,
    ...over,
  } as IamRoleBindingEntity;
}

function harness(rows: IamRoleBindingEntity[]) {
  const updates: Array<[string, Record<string, unknown>]> = [];
  const bindings = {
    find: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const upTo = (where.expiresAt as { value: Date }).value;
      return rows.filter(
        (r) =>
          !!r.expiresAt &&
          r.expiresAt <= upTo &&
          ('expiringNoticeAt' in where
            ? !r.expiringNoticeAt
            : !r.expiredNoticeAt),
      );
    }),
    update: jest.fn(async (id: string, patch: Record<string, unknown>) => {
      updates.push([id, patch]);
      const row = rows.find((r) => r.id === id);
      if (row) Object.assign(row, patch);
    }),
  };
  const users = {
    find: async () => [{ id: 'admin-1', email: 'admin@customer.example' }],
    findOne: async () => ({ id: 'owner-1', email: 'owner@customer.example' }),
  };
  const emitAlert = jest.fn();
  const send = jest.fn().mockResolvedValue({});
  const moduleRef = {
    get: (token: unknown) =>
      token === UserEventsGateway
        ? { emitAlert }
        : token === MailSendService
          ? { send }
          : undefined,
  };
  const config = {
    get: (k: string) =>
      k === 'MAIL_FROM' ? 'flui@customer.example' : undefined,
  };
  const svc = new GrantNoticeService(
    bindings as never,
    users as never,
    config as never,
    moduleRef as never,
  );
  return { svc, emitAlert, send, updates };
}

describe('GrantNoticeService', () => {
  it('warns the day before a grant lent for longer than a day ends, the person holding it included, once', async () => {
    const row = grant({});
    const { svc, send, emitAlert } = harness([row]);
    await svc.sweep(NOW);
    await svc.sweep(NOW);
    expect(send).toHaveBeenCalledTimes(1);
    const recipients = send.mock.calls[0][0].to.map(
      (t: { email: string }) => t.email,
    );
    expect(recipients).toEqual(
      expect.arrayContaining([
        'admin@customer.example',
        'owner@customer.example',
        'op@support.example',
      ]),
    );
    expect(emitAlert).toHaveBeenCalledTimes(2);
  });

  it('does not warn ahead of a grant lent for less than a day: the grant notice already said when', async () => {
    const row = grant({
      createdAt: new Date(NOW.getTime() - 2 * HOUR),
      expiresAt: new Date(NOW.getTime() + 6 * HOUR),
    });
    const { svc, send, updates } = harness([row]);
    await svc.sweep(NOW);
    expect(send).not.toHaveBeenCalled();
    expect(updates[0][1]).toHaveProperty('expiringNoticeAt');
  });

  it('announces the end once, to the administrators and the lender', async () => {
    const row = grant({
      expiresAt: new Date(NOW.getTime() - HOUR),
      expiringNoticeAt: new Date(NOW.getTime() - 20 * HOUR),
    });
    const { svc, send } = harness([row]);
    await svc.sweep(NOW);
    await svc.sweep(NOW);
    expect(send).toHaveBeenCalledTimes(1);
    const recipients = send.mock.calls[0][0].to.map(
      (t: { email: string }) => t.email,
    );
    expect(recipients).not.toContain('op@support.example');
    expect(send.mock.calls[0][0].subject).toContain('has ended');
  });

  it('announces a temporary grant when it is made, and nothing for a standing one', async () => {
    const { svc, send } = harness([]);
    await svc.granted(grant({ expiresAt: null }));
    expect(send).not.toHaveBeenCalled();
    await svc.granted(grant({}));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('says who, what and until when', () => {
    expect(
      sentenceFor(
        'granted',
        'Platform operator',
        'op@x',
        '2026-10-01T00:00:00.000Z',
      ),
    ).toBe(
      'op@x was given Platform operator access until 2026-10-01T00:00:00.000Z.',
    );
  });
});
