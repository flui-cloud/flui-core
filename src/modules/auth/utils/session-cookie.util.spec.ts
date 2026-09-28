import {
  clearFluiSessionCookie,
  setFluiSessionCookie,
} from './session-cookie.util';

describe('flui_session cookie', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  const recorder = () => {
    const calls: Array<{
      op: 'set' | 'clear';
      name: string;
      opts: Record<string, unknown>;
    }> = [];
    const res = {
      cookie: jest.fn((name: string, _v: string, opts: any) =>
        calls.push({ op: 'set', name, opts }),
      ),
      clearCookie: jest.fn((name: string, opts: any) =>
        calls.push({ op: 'clear', name, opts }),
      ),
    };
    return { res: res as any, calls };
  };

  it('stays on the API host: no Domain, so the browser never sends it to a sibling app', () => {
    process.env.API_BASE_URL = 'https://api.example.com';
    process.env.FLUI_COOKIE_DOMAIN = '.example.com';
    const { res, calls } = recorder();
    setFluiSessionCookie(res, 'header.payload.sig');
    const set = calls.filter((c) => c.op === 'set');
    expect(set).toHaveLength(1);
    expect(set[0].opts.domain).toBeUndefined();
  });

  it('removes the cookie an older release left on the parent domain', () => {
    process.env.API_BASE_URL = 'https://api.example.com';
    const { res, calls } = recorder();
    setFluiSessionCookie(res, 'header.payload.sig');
    expect(calls[0]).toMatchObject({
      op: 'clear',
      name: 'flui_session',
      opts: { domain: '.example.com' },
    });
  });

  it('signing out clears both the host cookie and the parent-domain one', () => {
    process.env.API_BASE_URL = 'https://api.example.com';
    const { res, calls } = recorder();
    clearFluiSessionCookie(res);
    const domains = calls.map((c) => c.opts.domain);
    expect(domains).toEqual(
      expect.arrayContaining([undefined, '.example.com']),
    );
  });

  it('has nothing to clean when the API address is unknown', () => {
    delete process.env.API_BASE_URL;
    delete process.env.FLUI_COOKIE_DOMAIN;
    const { res, calls } = recorder();
    setFluiSessionCookie(res, 'header.payload.sig');
    expect(calls.filter((c) => c.op === 'clear')).toHaveLength(0);
  });
});
