import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { Public } from '../../auth/decorators/public.decorator';
import { RegistryTokenService } from '../services/registry-token.service';

function basicCredentials(header: string | undefined): {
  username?: string;
  password?: string;
} {
  const match = /^Basic\s+(\S+)$/i.exec(header ?? '');
  if (!match) return {};
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const at = decoded.indexOf(':');
  return at < 0
    ? {}
    : { username: decoded.slice(0, at), password: decoded.slice(at + 1) };
}

/**
 * The realm of the instance's own registry: Docker's token authentication,
 * as `docker login`, BuildKit and containerd speak it.
 *
 * GET with Basic credentials is the form every client falls back to;
 * containerd tries the OAuth2 password grant (POST) first.
 */
const TOKENS_PER_MINUTE =
  Number(process.env.FLUI_REGISTRY_TOKENS_PER_MINUTE) || 120;

@ApiExcludeController()
@Public()
@UseGuards(ThrottlerGuard)
@Throttle({ default: { ttl: 60_000, limit: TOKENS_PER_MINUTE } })
@Controller('registry')
export class RegistryTokenController {
  constructor(private readonly tokens: RegistryTokenService) {}

  @Get('token')
  async token(
    @Headers('authorization') authorization: string | undefined,
    @Query('scope') scope: string | string[] | undefined,
    @Query('service') service: string | undefined,
  ) {
    const issued = await this.tokens.issue({
      ...basicCredentials(authorization),
      scope,
      service,
    });
    return {
      token: issued.token,
      access_token: issued.token,
      expires_in: issued.expiresIn,
      issued_at: issued.issuedAt.toISOString(),
    };
  }

  @Post('token')
  @HttpCode(200)
  async passwordGrant(
    @Body()
    body: {
      grant_type?: string;
      username?: string;
      password?: string;
      scope?: string;
      service?: string;
    },
  ) {
    const issued = await this.tokens.issue({
      username: body.grant_type === 'password' ? body.username : undefined,
      password: body.grant_type === 'password' ? body.password : undefined,
      scope: body.scope,
      service: body.service,
    });
    return {
      access_token: issued.token,
      expires_in: issued.expiresIn,
      issued_at: issued.issuedAt.toISOString(),
    };
  }
}
