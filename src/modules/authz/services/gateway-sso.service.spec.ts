jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));

import * as crypto from 'node:crypto';
import { GatewaySsoService, gatewaySsoCookieName } from './gateway-sso.service';

describe('GatewaySsoService', () => {
  const master = crypto.randomBytes(32);
  const make = (
    opts: { fqdn?: string; deny?: boolean; path?: string } = {},
  ) => {
    const store = new Map<string, unknown>();
    const cache = {
      set: jest.fn(async (k: string, v: unknown) => void store.set(k, v)),
      get: jest.fn(async (k: string) => store.get(k)),
      delete: jest.fn(async (k: string) => void store.delete(k)),
    };
    const authz = {
      authorizeRoute: jest.fn(async () => {
        if (opts.deny) throw new Error('forbidden');
        return {
          endpoint: {
            fqdn: opts.fqdn ?? 'app.example.com',
            gatewayConfig: opts.path ? { path: opts.path } : null,
          },
        };
      }),
    };
    const encryption = {
      deriveSubkey: (domain: string) =>
        Buffer.from(
          crypto.hkdfSync('sha256', master, Buffer.alloc(0), domain, 32),
        ),
    };
    const users = {
      findOne: jest.fn(async () => ({
        id: 'u1',
        email: 'a@b.c',
        role: 'user',
        isAdmin: false,
      })),
    };
    const config = { get: () => 'https://dashboard.example.com/' };
    const service = new GatewaySsoService(
      {} as any,
      users as any,
      authz as any,
      encryption as any,
      cache as any,
      config as any,
    );
    return { service, authz };
  };
  const user = { userId: 'u1', email: 'a@b.c', roles: {}, role: 'user' } as any;

  it('accepts its own cookie only on the route it was minted for', () => {
    const { service } = make();
    const value = service.mint('u1', 'route-a');
    expect(service.verify(value, 'route-a')).toBe('u1');
    expect(service.verify(value, 'route-b')).toBeNull();
  });

  it('rejects a cookie whose user was changed, or that has expired', () => {
    const { service } = make();
    const value = service.mint('u1', 'route-a', 0);
    expect(service.verify(value, 'route-a')).toBeNull();
    const fresh = service.mint('u1', 'route-a').replace('.u1.', '.u2.');
    expect(service.verify(fresh, 'route-a')).toBeNull();
  });

  it('never sends a credential to another host', async () => {
    const { service } = make();
    await expect(
      service.issueCode(user, 'route-a', 'https://evil.example.net/'),
    ).rejects.toThrow('https://app.example.com');
    await expect(
      service.issueCode(user, 'route-a', 'http://app.example.com/'),
    ).rejects.toThrow();
  });

  it('refuses a code to someone who may not open the route', async () => {
    const { service } = make({ deny: true });
    await expect(
      service.issueCode(user, 'route-a', 'https://app.example.com/x'),
    ).rejects.toThrow('forbidden');
  });

  it('turns a code into the cookie once, on its own route', async () => {
    const { service } = make();
    const { redirect } = await service.issueCode(
      user,
      'route-a',
      'https://app.example.com/reports?y=1',
    );
    const url = new URL(redirect);
    expect(url.host).toBe('app.example.com');
    expect(url.pathname).toBe('/.flui-sso/callback');
    const code = url.searchParams.get('code');

    await expect(service.exchangeCode('route-b', code)).rejects.toThrow();
    const again = await service.issueCode(
      user,
      'route-a',
      'https://app.example.com/reports?y=1',
    );
    const code2 = new URL(again.redirect).searchParams.get('code');
    const { cookie, returnUrl } = await service.exchangeCode('route-a', code2);
    expect(returnUrl).toBe('https://app.example.com/reports?y=1');
    expect(cookie).toMatch(
      new RegExp(
        `^${gatewaySsoCookieName('route-a')}=v1\\.u1\\.\\d+\\.[\\w-]+; Path=/; Secure; HttpOnly; SameSite=Lax`,
      ),
    );
    await expect(service.exchangeCode('route-a', code2)).rejects.toThrow();
  });

  it('rebuilds the person from their account, not from the cookie', async () => {
    const { service } = make();
    const value = service.mint('u1', 'route-a');
    const found = await service.userFromCookie(
      'route-a',
      `other=1; ${gatewaySsoCookieName('route-a')}=${value}`,
    );
    expect(found).toMatchObject({ userId: 'u1', isAdmin: false, roles: {} });
    expect(await service.userFromCookie('route-a', 'other=1')).toBeNull();
  });

  it("puts the callback under the route's own path", async () => {
    const { service } = make({ path: '/api/' });
    const { redirect } = await service.issueCode(
      user,
      'route-a',
      'https://app.example.com/api/x',
    );
    expect(new URL(redirect).pathname).toBe('/api/.flui-sso/callback');
  });

  it('sends a browser to the dashboard with the route and the page', () => {
    const { service } = make();
    const url = new URL(
      service.loginUrl('route-a', 'https://app.example.com/x?y=1'),
    );
    expect(url.origin + url.pathname).toBe(
      'https://dashboard.example.com/gateway-login',
    );
    expect(url.searchParams.get('return')).toBe(
      'https://app.example.com/x?y=1',
    );
  });
});
