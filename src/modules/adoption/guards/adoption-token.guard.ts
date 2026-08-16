import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import {
  AdoptionTokenService,
  type AdoptionTokenPayload,
} from '../services/adoption-token.service';

export interface AdoptionRequest {
  adoption?: AdoptionTokenPayload;
}

/**
 * Lets an adoption token stand in for a session, and nothing more.
 *
 * A cluster built on someone else's behalf has no user, no session and no way
 * to prove who its owner is — the whole point of the managed path is that the
 * builder keeps nothing. So the token is the credential, and this guard is the
 * only place in the product where a bearer string that is not a session opens a
 * route. It therefore refuses everything it cannot positively verify: wrong
 * signature, expired, already spent, or naming a cluster this installation does
 * not have.
 *
 * The spent list lives on the cluster record, not in a table of its own. It is
 * the cluster being adopted, the entries expire with the tokens, and it needs
 * no schema change to a product that is already installed in the field.
 */
@Injectable()
export class AdoptionTokenGuard implements CanActivate {
  private readonly logger = new Logger(AdoptionTokenGuard.name);

  constructor(
    private readonly tokens: AdoptionTokenService,
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<
        { headers: Record<string, string | undefined> } & AdoptionRequest
      >();

    const header = request.headers['authorization'] ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) {
      throw new UnauthorizedException('An adoption token is required.');
    }

    // Signature and expiry first, before the token's own claims are used to
    // look anything up. Only then is the cluster it names worth reading.
    const verdict = this.tokens.verify(token);
    if (!verdict.valid || !verdict.payload) {
      // Logged without the token: it is a live credential until it expires.
      this.logger.warn(`Adoption refused: ${verdict.reason}`);
      throw new UnauthorizedException(
        verdict.reason ?? 'Invalid adoption token.',
      );
    }

    const spent = await this.spentTokens(verdict.payload.clusterId);
    if (spent.includes(verdict.payload.jti)) {
      this.logger.warn('Adoption refused: token already used.');
      throw new UnauthorizedException(
        'This adoption token has already been used. Issue a new one from the dashboard.',
      );
    }

    request.adoption = verdict.payload;
    return true;
  }

  private async spentTokens(clusterId: string): Promise<string[]> {
    const cluster = await this.clusters.findOne({ where: { id: clusterId } });
    const metadata = (cluster?.metadata ?? {}) as {
      adoption?: { spent?: unknown };
    };
    const spent = metadata.adoption?.spent;
    return Array.isArray(spent)
      ? spent.filter((v): v is string => typeof v === 'string')
      : [];
  }
}
