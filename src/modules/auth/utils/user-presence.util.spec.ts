import { ForbiddenException } from '@nestjs/common';
import { noteSeen, refuseIfBlocked } from './user-presence.util';

describe('refuseIfBlocked', () => {
  it('refuses a blocked person with a code the interface can read', () => {
    expect(() => refuseIfBlocked({ blockedAt: new Date() })).toThrow(
      ForbiddenException,
    );
    try {
      refuseIfBlocked({ blockedAt: new Date() });
    } catch (e) {
      expect((e as ForbiddenException).getResponse()).toMatchObject({
        code: 'ACCOUNT_BLOCKED',
      });
    }
  });

  it('lets everyone else through', () => {
    expect(() => refuseIfBlocked({ blockedAt: null })).not.toThrow();
  });
});

describe('noteSeen', () => {
  const flush = () => new Promise((r) => setImmediate(r));

  it('writes at most every quarter of an hour', async () => {
    const update = jest.fn(async () => undefined);
    const user = { id: 'u1', lastSeenAt: null as Date | null };
    const t0 = new Date('2026-10-07T12:00:00Z');

    noteSeen({ update } as never, user, t0);
    noteSeen({ update } as never, user, new Date(t0.getTime() + 60_000));
    noteSeen({ update } as never, user, new Date(t0.getTime() + 16 * 60_000));
    await flush();

    expect(update).toHaveBeenCalledTimes(2);
  });

  it('never fails the request when the write does', async () => {
    const user = { id: 'u1', lastSeenAt: null as Date | null };
    expect(() =>
      noteSeen(
        {
          update: () => {
            throw new Error('db down');
          },
        } as never,
        user,
      ),
    ).not.toThrow();
    await flush();
  });
});
