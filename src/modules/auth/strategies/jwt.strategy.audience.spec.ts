jest.mock('jwks-rsa', () => ({ passportJwtSecret: jest.fn(() => jest.fn()) }));

import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';

describe('a token that was not issued for Flui', () => {
  const validate = (aud: unknown) =>
    JwtStrategy.prototype.validate.call(
      {},
      { sub: 's', email: 'a@example.com', iss: 'https://idp.example', aud },
    );

  afterEach(() => {
    delete process.env.OIDC_AUDIENCE;
  });

  it('is refused when its audience lacks the Flui client', async () => {
    process.env.OIDC_AUDIENCE = 'flui-web';
    await expect(validate(['customer-app'])).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('is refused while the installation does not know its audience yet', async () => {
    await expect(validate(['flui-web'])).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
