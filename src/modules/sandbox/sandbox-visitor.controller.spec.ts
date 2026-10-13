import { SandboxVisitorController } from './sandbox-visitor.controller';

describe('SandboxVisitorController', () => {
  const build = () => {
    const admissions = {
      admit: jest.fn(async () => ({ nonce: 'n', expiresInSeconds: 120 })),
    };
    const login = {
      enter: jest.fn(async () => 'http://localhost:4200/auth/callback?code=c'),
    };
    return {
      controller: new SandboxVisitorController(
        admissions as never,
        login as never,
      ),
      admissions,
      login,
    };
  };

  it('counts the admission against the address the request came from', async () => {
    const t = build();
    await t.controller.admission({ ip: '203.0.113.7' } as never, {
      turnstileToken: 'tok',
    });
    expect(t.admissions.admit).toHaveBeenCalledWith({
      ip: '203.0.113.7',
      turnstileToken: 'tok',
      cli: false,
    });
  });

  it('redirects where the sign-in says, uncached, and passes only a well-formed request id', async () => {
    const t = build();
    const res = { setHeader: jest.fn(), redirect: jest.fn() };
    await t.controller.enter('V2_123', undefined, res as never);
    expect(t.login.enter).toHaveBeenCalledWith('V2_123');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      'http://localhost:4200/auth/callback?code=c',
    );

    await t.controller.enter('https://evil.test/x', undefined, res as never);
    expect(t.login.enter).toHaveBeenLastCalledWith(null);
  });
});
