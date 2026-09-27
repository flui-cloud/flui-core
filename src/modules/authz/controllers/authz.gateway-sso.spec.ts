jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));
jest.mock('ip-cidr', () => ({}));

import { AuthzController } from './authz.controller';

describe('gateway forwardAuth without a Flui credential', () => {
  const res = () => {
    const r: any = { headers: {} as Record<string, string> };
    r.setHeader = jest.fn((k: string, v: string) => (r.headers[k] = v));
    r.redirect = jest.fn((status: number, url: string) => {
      r.statusCode = status;
      r.location = url;
    });
    r.status = jest.fn((s: number) => ((r.statusCode = s), r));
    r.end = jest.fn();
    return r;
  };
  const make = () => {
    const sso = {
      exchangeCode: jest.fn(async () => ({
        cookie: '__Host-flui-gw=v; Path=/',
        returnUrl: 'https://app.example.com/x',
      })),
      userFromCookie: jest.fn(async () => null),
      endpointFqdn: jest.fn(async () => 'app.example.com'),
      loginUrl: jest.fn(
        (id: string, back: string) =>
          `https://dash/gateway-login?r=${id}&b=${back}`,
      ),
    };
    const authz = {
      authorizeRoute: jest.fn(async () => ({ appSlug: 'app' })),
    };
    const controller = new AuthzController(
      {} as any,
      authz as any,
      {} as any,
      sso as any,
    );
    return { controller, sso, authz };
  };
  const req = (headers: Record<string, string>) => ({ headers }) as any;

  it('sends a browser to sign in, remembering the page', async () => {
    const { controller } = make();
    const r = res();
    await controller.gatewayRoute(
      req({ accept: 'text/html,*/*', 'x-forwarded-uri': '/reports?y=1' }),
      r,
      'route-a',
    );
    expect(r.statusCode).toBe(302);
    expect(r.location).toBe(
      'https://dash/gateway-login?r=route-a&b=https://app.example.com/reports?y=1',
    );
  });

  it('keeps answering 401 to an API client', async () => {
    const { controller } = make();
    await expect(
      controller.gatewayRoute(
        req({ accept: 'application/json', 'x-forwarded-uri': '/api' }),
        res(),
        'route-a',
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('spends the code on the callback and sends the browser back with the cookie', async () => {
    const { controller, sso } = make();
    const r = res();
    await controller.gatewayRoute(
      req({ 'x-forwarded-uri': '/.flui-sso/callback?code=abc' }),
      r,
      'route-a',
    );
    expect(sso.exchangeCode).toHaveBeenCalledWith('route-a', 'abc');
    expect(r.headers['Set-Cookie']).toBe('__Host-flui-gw=v; Path=/');
    expect(r.location).toBe('https://app.example.com/x');
  });

  it('lets the cookie through with the role checked', async () => {
    const { controller, sso, authz } = make();
    sso.userFromCookie.mockResolvedValueOnce({ userId: 'u1' } as any);
    const r = res();
    await controller.gatewayRoute(req({ cookie: 'x' }), r, 'route-a');
    expect(authz.authorizeRoute).toHaveBeenCalledWith(
      { userId: 'u1' },
      'route-a',
    );
    expect(r.statusCode).toBe(200);
    expect(r.headers['X-Auth-User']).toBe('u1');
  });
});
