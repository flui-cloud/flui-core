import { SetMetadata } from '@nestjs/common';

export const REQUIRED_SCOPES_KEY = 'requiredScopes';

/** Gate a route on one or more granted scopes (default-deny if the principal lacks them). */
export const RequireScope = (...scopes: string[]) =>
  SetMetadata(REQUIRED_SCOPES_KEY, scopes);
