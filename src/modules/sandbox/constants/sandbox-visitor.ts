import { UnauthorizedException } from '@nestjs/common';

export const SANDBOX_SIGN_IN_REQUIRED_CODE = 'SANDBOX_SIGN_IN_REQUIRED';

export const SANDBOX_SIGN_IN_REQUIRED_MESSAGE =
  'Sign in with GitHub, Google or email to do this; you can keep looking around.';

/** A visitor asked for something only a signed-in guest may do. */
export function signInRequired(route?: string): UnauthorizedException {
  return new UnauthorizedException({
    statusCode: 401,
    code: SANDBOX_SIGN_IN_REQUIRED_CODE,
    message: SANDBOX_SIGN_IN_REQUIRED_MESSAGE,
    ...(route ? { route } : {}),
  });
}
