import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import {
  CURRENT_API_KEY_ID,
  ApiKeyStrategy,
} from '../strategies/api-key.strategy';
import { extractJwtFromFluiSessionCookie } from '../utils/cookie-extractor.util';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(
    private readonly reflector: Reflector,
    private readonly apiKeyStrategy: ApiKeyStrategy,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const authHeader: string = request.headers['authorization'] || '';
    // A sandbox guest is handed its credential as a cookie, because the claim
    // that creates it is a page navigation, not an XHR that could set a header.
    const token =
      authHeader.replace(/^Bearer\s+/i, '') ||
      extractJwtFromFluiSessionCookie(request) ||
      '';

    // API key M2M — valid for both local and OIDC modes
    if (token.startsWith('flui_')) {
      const { user, keyId } =
        await this.apiKeyStrategy.validateWithRecord(token);
      request.user = user;
      // On the request, never on the principal: see CURRENT_API_KEY_ID.
      request[CURRENT_API_KEY_ID] = keyId;
      return true;
    }

    // JWT strategy selected at runtime based on AUTH_MODE
    const strategy = process.env.AUTH_MODE === 'local' ? 'local-jwt' : 'jwt';
    return AuthGuard(strategy).prototype.canActivate.call(
      this,
      context,
    ) as Promise<boolean>;
  }
}
