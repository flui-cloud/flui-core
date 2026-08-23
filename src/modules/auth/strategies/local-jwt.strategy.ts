import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { IdentityRole } from '../entities/user.entity';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { extractJwtFromFluiSessionCookie } from '../utils/cookie-extractor.util';
import { resolveJwtSecret } from '../utils/jwt-secret.util';

interface LocalJwtPayload {
  sub: string;
  email: string;
  isAdmin: boolean;
  role?: IdentityRole;
}

@Injectable()
export class LocalJwtStrategy extends PassportStrategy(Strategy, 'local-jwt') {
  constructor(configService: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        extractJwtFromFluiSessionCookie,
      ]),
      secretOrKey: resolveJwtSecret(configService),
      algorithms: ['HS256'],
    });
  }

  validate(payload: LocalJwtPayload): AuthenticatedUser {
    return {
      userId: payload.sub,
      email: payload.email,
      roles: {},
      role:
        payload.role ??
        (payload.isAdmin ? IdentityRole.ADMIN : IdentityRole.USER),
      isAdmin: payload.isAdmin,
    };
  }
}
