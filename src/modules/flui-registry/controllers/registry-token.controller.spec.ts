import { RegistryTokenController } from './registry-token.controller';

describe('the registry token realm', () => {
  const issue = jest.fn(async () => ({
    token: 't',
    expiresIn: 300,
    issuedAt: new Date('2026-10-09T00:00:00Z'),
  }));
  const controller = new RegistryTokenController({ issue } as never);
  beforeEach(() => issue.mockClear());

  it('reads Basic credentials, keeping a colon inside the password', async () => {
    const header = `Basic ${Buffer.from('user-1:pa:ss').toString('base64')}`;
    const body = await controller.token(
      header,
      'repository:apps/a:pull',
      'flui-registry',
    );

    expect(issue).toHaveBeenCalledWith({
      username: 'user-1',
      password: 'pa:ss',
      scope: 'repository:apps/a:pull',
      service: 'flui-registry',
    });
    expect(body).toEqual({
      token: 't',
      access_token: 't',
      expires_in: 300,
      issued_at: '2026-10-09T00:00:00.000Z',
    });
  });

  it('passes no credentials for a header that is not Basic', async () => {
    await controller.token('Bearer abc', undefined, undefined);
    expect(issue).toHaveBeenCalledWith({
      scope: undefined,
      service: undefined,
    });
  });

  it('takes credentials from the password grant only', async () => {
    await controller.passwordGrant({
      grant_type: 'refresh_token',
      username: 'u',
      password: 'p',
    });
    expect(issue).toHaveBeenLastCalledWith(
      expect.objectContaining({ username: undefined, password: undefined }),
    );
    await controller.passwordGrant({
      grant_type: 'password',
      username: 'u',
      password: 'p',
      scope: 'repository:apps/a:pull',
    });
    expect(issue).toHaveBeenLastCalledWith(
      expect.objectContaining({ username: 'u', password: 'p' }),
    );
  });
});
