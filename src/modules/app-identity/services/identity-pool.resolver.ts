import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ApplicationsRepository } from '../../applications/repositories/applications.repository';
import { AppEndpointService } from '../../dns/services/app-endpoint.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { IdentityPool } from '../zitadel/identity-pool';
import { ZitadelIdentityPool } from '../zitadel/zitadel-identity-pool';

export const IDENTITY_POOL_FACTORY = 'IDENTITY_POOL_FACTORY';
export type IdentityPoolFactory = (issuer: string, key: string) => IdentityPool;

export const IDENTITY_COMPONENT = 'zitadel';
export const IDENTITY_KEY_VAR = 'FLUI_SYSTEM_KEY';
export const IDENTITY_PROJECT = 'Flui apps';

export interface ResolvedPool {
  pool: IdentityPool;
  issuer: string;
  server: ApplicationEntity;
}

/**
 * Finds the identity server of an identity install and reaches it with the key
 * only that install holds. No permission check here: callers ask it first.
 */
@Injectable()
export class IdentityPoolResolver {
  private readonly makePool: IdentityPoolFactory;

  constructor(
    private readonly applications: ApplicationsRepository,
    private readonly endpoints: AppEndpointService,
    private readonly encryption: EncryptionService,
    @Optional() @Inject(IDENTITY_POOL_FACTORY) factory?: IdentityPoolFactory,
  ) {
    this.makePool =
      factory ?? ((issuer, key) => new ZitadelIdentityPool(issuer, key));
  }

  async server(installId: string): Promise<ApplicationEntity> {
    const server = (
      await this.applications.findByCatalogInstall(installId)
    ).find((a) => a.metadata?.composedComponent === IDENTITY_COMPONENT);
    if (!server) {
      throw new NotFoundException(`No identity install ${installId}`);
    }
    return server;
  }

  async resolve(installId: string): Promise<ResolvedPool> {
    const server = await this.server(installId);
    const key = server.env?.find((e) => e.name === IDENTITY_KEY_VAR);
    if (!key?.value) {
      throw new ConflictException(
        'This identity install predates the key Flui manages it with. Reinstall it to manage its users from Flui.',
      );
    }
    const issuer = `https://${await this.addressOf(server)}`;
    return {
      pool: this.makePool(issuer, this.encryption.decrypt(key.value)),
      issuer,
      server,
    };
  }

  async addressOf(app: ApplicationEntity): Promise<string> {
    const [endpoint] = await this.endpoints.listByApplicationId(app.id);
    if (!endpoint?.fqdn) {
      throw new ConflictException(
        `${app.slug} has no public address yet, so there is nowhere to send people back to after sign-in.`,
      );
    }
    return endpoint.fqdn;
  }
}
