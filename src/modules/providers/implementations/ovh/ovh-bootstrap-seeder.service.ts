import { Injectable } from '@nestjs/common';
import { CloudProvider } from '../../enums/cloud-provider.enum';
import { CredentialType } from '../../../management/entities/credentials.entity';
import {
  IProviderBootstrapSeeder,
  ProviderBootstrapCredentials,
} from '../../core/interfaces/provider-bootstrap-seeder.interface';

@Injectable()
export class OvhBootstrapSeeder implements IProviderBootstrapSeeder {
  readonly provider = CloudProvider.OVH;

  buildCredentials(
    env: NodeJS.ProcessEnv,
  ): ProviderBootstrapCredentials | null {
    const accessKey = env.PROVIDER_OVH_ACCESS_KEY;
    const secretKey = env.PROVIDER_OVH_SECRET_KEY;
    if (!accessKey || !secretKey) return null;
    return {
      credentialType: CredentialType.ACCESS_KEY_SECRET,
      token: secretKey,
      accessKey,
      label: 'OVH OpenStack Credentials (bootstrap)',
    };
  }

  /**
   * OVH server IDs are Nova UUIDs — already the canonical shape the CLI
   * captures at server-create time, unlike Hetzner's numeric IDs or
   * Scaleway's zone-prefixed strings. Nothing to resolve.
   */
  async resolveProviderResourceId(args: {
    instanceId: string;
    instanceName: string;
    env: NodeJS.ProcessEnv;
  }): Promise<string> {
    return args.instanceId;
  }
}
