jest.mock('@kubernetes/client-node', () => ({}));

import { ForbiddenException } from '@nestjs/common';
import { CURRENT_API_KEY_ID } from '../auth/strategies/api-key.strategy';
import { SandboxVisitorUpgradeController } from './sandbox-visitor-upgrade.controller';

describe('SandboxVisitorUpgradeController', () => {
  const build = () => {
    const upgrade = {
      providers: jest.fn(),
      start: jest.fn(async () => ({ authUrl: 'https://github.com/x' })),
      callback: jest.fn(
        async () => 'https://try.example.com/?visitor=finish&flow=f',
      ),
      finish: jest.fn(async () => ({ outcome: 'upgraded' })),
    };
    const links = {
      visitorOrRefuse: jest.fn(async () => ({ id: 'v1' })),
      createIntent: jest.fn(async () => ({
        nonce: 'n',
        expiresAt: new Date('2026-10-13T12:15:00Z'),
      })),
      link: jest.fn(async () => ({ outcome: 'linked', returnTo: null })),
    };
    const hits = new Map<string, number>();
    const throttler = {
      increment: jest.fn(async (key: string) => {
        hits.set(key, (hits.get(key) ?? 0) + 1);
        return { totalHits: hits.get(key)!, timeToExpire: 600 };
      }),
    };
    return {
      throttler,
      controller: new SandboxVisitorUpgradeController(
        upgrade as never,
        links as never,
        throttler as never,
      ),
      upgrade,
      links,
    };
  };
  const person = { user: { userId: 'v1' } } as never;

  it('passes only a dashboard path to come back to', async () => {
    const t = build();
    await t.controller.start(person, {
      provider: 'github',
      returnTo: 'https://evil.example/',
    });
    await t.controller.start(person, { provider: 'github', returnTo: '/apps' });
    expect(t.upgrade.start.mock.calls).toEqual([
      ['v1', 'github', null],
      ['v1', 'github', '/apps'],
    ]);
  });

  it('never lets an API key start, finish or link', async () => {
    const t = build();
    const agent = {
      user: { userId: 'v1' },
      [CURRENT_API_KEY_ID]: 'k1',
    } as never;
    await expect(
      t.controller.start(agent, { provider: 'github' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(() => t.controller.finish(agent, { flow: 'f'.repeat(43) })).toThrow(
      ForbiddenException,
    );
    expect(() => t.controller.link(agent, { nonce: 'n'.repeat(43) })).toThrow(
      ForbiddenException,
    );
    await expect(t.controller.linkIntent(agent, {})).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('lets one visitor start five sign-ins per ten minutes', async () => {
    const t = build();
    for (let i = 0; i < 5; i++) {
      await t.controller.start(person, { provider: 'github' });
    }
    await expect(
      t.controller.start(person, { provider: 'github' }),
    ).rejects.toMatchObject({
      status: 429,
      response: { code: 'SANDBOX_VISITOR_UPGRADE_LIMIT' },
    });
    expect(t.upgrade.start).toHaveBeenCalledTimes(5);
    expect(t.throttler.increment).toHaveBeenCalledWith(
      'visitor:v1',
      600_000,
      5,
      0,
      'sandbox-visitor-upgrade',
    );
    await t.controller.start({ user: { userId: 'v2' } } as never, {
      provider: 'github',
    });
  });

  it('redirects from the provider uncached, with no referrer, dropping odd query values', async () => {
    const t = build();
    const res = { setHeader: jest.fn(), redirect: jest.fn() };
    await t.controller.callback('success', ['a', 'b'], 'tok', res as never);
    expect(t.upgrade.callback).toHaveBeenCalledWith({
      result: 'success',
      id: undefined,
      token: 'tok',
    });
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(res.setHeader).toHaveBeenCalledWith(
      'Referrer-Policy',
      'no-referrer',
    );
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      'https://try.example.com/?visitor=finish&flow=f',
    );
  });

  it('hands out a link nonce to the visitor calling', async () => {
    const t = build();
    expect(
      await t.controller.linkIntent(person, { returnTo: '/apps' }),
    ).toEqual({
      nonce: 'n',
      expiresAt: '2026-10-13T12:15:00.000Z',
    });
    expect(t.links.createIntent).toHaveBeenCalledWith('v1', '/apps');
  });
});
