import { isSandboxAllowed, isVisitorWritable } from './sandbox-fence';

describe('a guest’s own account', () => {
  const OPEN = [
    'GET /account',
    'PUT /account/profile',
    'GET /account/password-policy',
    'POST /account/password',
    'POST /account/totp',
    'POST /account/totp/verify',
    'DELETE /account/totp',
    'DELETE /account/passkeys/:id',
    'DELETE /account/security-keys/:id',
  ];

  it('opens the guest’s own name, password and second factors', () => {
    for (const route of OPEN) {
      const [verb, path] = route.split(' ');
      expect({ route, open: isSandboxAllowed(verb, path, true) }).toEqual({
        route,
        open: true,
      });
    }
  });

  it('keeps the sign-in the guest entered with', () => {
    expect(
      isSandboxAllowed('DELETE', '/account/links/:idpId/:externalUserId', true),
    ).toBe(false);
    expect(isSandboxAllowed('POST', '/account/links', true)).toBe(false);
  });

  it('lets a visitor write none of it', () => {
    for (const route of OPEN) {
      const [verb, path] = route.split(' ');
      expect({ route, visitor: isVisitorWritable(verb, path, true) }).toEqual({
        route,
        visitor: false,
      });
    }
  });
});
