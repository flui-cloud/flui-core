import {
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { Public } from '../../auth/decorators/public.decorator';
import { ClusterNatsService } from '../services/cluster-nats.service';

const ACCOUNT_KEY = /^A[A-Z2-7]{55}$/;

/**
 * Where a cluster's NATS learns its accounts. Public because the server asks
 * without signing in; an account JWT is public by construction — it names a
 * public key and its limits, and only the matching seed can act as it.
 */
@ApiTags('Webhooks')
@Controller('messaging/nats/accounts')
export class NatsAccountsController {
  constructor(private readonly nats: ClusterNatsService) {}

  @Get()
  @Public()
  @ApiExcludeEndpoint()
  @Header('Content-Type', 'text/plain')
  root(): string {
    return '';
  }

  @Get(':publicKey')
  @Public()
  @ApiExcludeEndpoint()
  @Header('Content-Type', 'text/plain')
  async account(@Param('publicKey') publicKey: string): Promise<string> {
    const jwt = ACCOUNT_KEY.test(publicKey)
      ? await this.nats.accountJwt(publicKey)
      : null;
    if (!jwt) throw new NotFoundException();
    return jwt;
  }
}
