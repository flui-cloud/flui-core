import { UnauthorizedException } from '@nestjs/common';

export const SANDBOX_SIGN_IN_REQUIRED_CODE = 'SANDBOX_SIGN_IN_REQUIRED';

export const INSTALL_FLUI_URL = 'https://flui.cloud/#install';

export const SANDBOX_SIGN_IN_REQUIRED_MESSAGE = `This demo is read-only. Install Flui on your own server to do this: ${INSTALL_FLUI_URL}`;

/** A visitor asked to change something in the read-only demo. */
export function signInRequired(route?: string): UnauthorizedException {
  return new UnauthorizedException({
    statusCode: 401,
    code: SANDBOX_SIGN_IN_REQUIRED_CODE,
    message: SANDBOX_SIGN_IN_REQUIRED_MESSAGE,
    ...(route ? { route } : {}),
  });
}
