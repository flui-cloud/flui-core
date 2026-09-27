import { SetMetadata } from '@nestjs/common';

export const IS_OPTIONAL_AUTH_KEY = 'isOptionalAuth';
/**
 * A credential, when one is sent, is validated as anywhere else; a request
 * with none reaches the handler without a user, which decides what that means.
 */
export const OptionalAuth = () => SetMetadata(IS_OPTIONAL_AUTH_KEY, true);
