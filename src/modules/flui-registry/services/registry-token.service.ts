import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { IsNull, Repository } from 'typeorm';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import {
  FLUI_REGISTRY_CONFIG,
  FluiRegistryConfig,
  registryRepositoryFor,
} from '../flui-registry.config';
import { grantRegistryAccess, parseRegistryScopes } from '../registry-scope';
import { FluiRegistryClientService } from './flui-registry-client.service';
import { RegistryCredentialsService } from './registry-credentials.service';
import { RegistrySigningKeyService } from './registry-signing-key.service';

export interface RegistryTokenRequest {
  username?: string;
  password?: string;
  scope?: string | string[];
  service?: string;
}

export interface RegistryToken {
  token: string;
  expiresIn: number;
  issuedAt: Date;
}

@Injectable()
export class RegistryTokenService {
  constructor(
    @Inject(FLUI_REGISTRY_CONFIG) private readonly config: FluiRegistryConfig,
    private readonly credentials: RegistryCredentialsService,
    private readonly keys: RegistrySigningKeyService,
    @InjectRepository(ApplicationEntity)
    private readonly applications: Repository<ApplicationEntity>,
    private readonly registry: FluiRegistryClientService,
  ) {}

  private readonly sizes = new Map<string, { bytes: number; at: number }>();

  /**
   * A push is refused once the application's images already fill its share.
   * Checked when the token is asked for, so one push can still land past the
   * line; the per-request ceiling on the route bounds how far.
   */
  private async assertRoomToPush(applicationId: string): Promise<void> {
    const quota = this.config.appQuotaMb;
    if (!quota) return;
    const cached = this.sizes.get(applicationId);
    const bytes =
      cached && Date.now() - cached.at < 60_000
        ? cached.bytes
        : await this.registry.repositorySizeBytes(applicationId);
    this.sizes.set(applicationId, { bytes, at: Date.now() });
    const usedMb = Math.ceil(bytes / (1024 * 1024));
    if (usedMb >= quota) {
      throw new ForbiddenException(
        `This application's images take ${usedMb} MB of the ${quota} MB it may use on this instance's registry. Delete old versions before pushing another.`,
      );
    }
  }

  async issue(request: RegistryTokenRequest): Promise<RegistryToken> {
    if (this.config.mode !== 'flui') {
      throw new NotFoundException('This instance does not run a registry');
    }
    if (request.service && request.service !== this.config.service) {
      throw new BadRequestException(`Unknown service "${request.service}"`);
    }
    const credential = await this.credentials.verify(
      request.username,
      request.password,
    );
    const application = credential
      ? await this.applications.findOne({
          where: { id: credential.applicationId, deletedAt: IsNull() },
        })
      : null;
    if (!credential || !application) {
      throw new UnauthorizedException('Invalid registry credentials');
    }

    const access = grantRegistryAccess(parseRegistryScopes(request.scope), {
      name: registryRepositoryFor(application.id),
      actions: credential.kind === 'push' ? ['pull', 'push'] : ['pull'],
    });
    if (access.some((a) => a.actions.includes('push'))) {
      await this.assertRoomToPush(application.id);
    }
    const expiresIn =
      credential.kind === 'push'
        ? this.config.pushTokenSeconds
        : this.config.pullTokenSeconds;
    const issuedAt = new Date();
    const now = Math.floor(issuedAt.getTime() / 1000);
    const token = await this.keys.sign({
      iss: this.config.issuer,
      sub: `${credential.kind}:${application.id}`,
      aud: this.config.service,
      iat: now,
      nbf: now,
      exp: now + expiresIn,
      jti: randomUUID(),
      access,
    });
    return { token, expiresIn, issuedAt };
  }
}
