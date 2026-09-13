import { Injectable, Logger } from '@nestjs/common';
import {
  IObjectStorageProvisioner,
  ProvisionerCapability,
  ProvisionerReadiness,
  ProvisionInput,
  ProvisionResult,
} from '../../../../storage/interfaces/object-storage-provisioner.interface';
import { StorageBackendProvider } from '../../../../storage/enums/storage-backend-provider.enum';
import { GenericS3Backend } from '../../../../storage/implementations/generic-s3.backend';
import { OvhEc2CredentialsService } from './ovh-ec2-credentials.service';
import { OvhObjectStoragePreset } from './ovh-object-storage.preset';

/**
 * OVH Object Storage provisioner — FULL_AUTO, like Scaleway. Where Scaleway
 * reuses its compute key verbatim, OVH derives an S3 key pair from the stored
 * OpenStack credential (see OvhEc2CredentialsService); the customer is asked
 * for nothing extra either way.
 *
 * OVH prices ingress and egress at zero, which makes it attractive as a
 * destination for clusters hosted elsewhere — which is also the only correct
 * way to use it, since backups must not sit on the cluster's own provider.
 */
@Injectable()
export class OvhObjectStorageProvisioner implements IObjectStorageProvisioner {
  private readonly logger = new Logger(OvhObjectStorageProvisioner.name);
  readonly provider = StorageBackendProvider.OVH_OBJECT_STORAGE;
  readonly capability = ProvisionerCapability.FULL_AUTO;

  constructor(
    private readonly preset: OvhObjectStoragePreset,
    private readonly ec2Credentials: OvhEc2CredentialsService,
    private readonly genericS3: GenericS3Backend,
  ) {}

  async isReady(_userId: string): Promise<ProvisionerReadiness> {
    const connected = await this.ec2Credentials.hasComputeCredential();
    if (!connected) {
      return {
        ready: false,
        reason: 'CONNECT_OVH_REQUIRED',
        message:
          'OVH non collegato. Aggiungi credenziali OVH nelle impostazioni provider.',
      };
    }
    return { ready: true };
  }

  async provisionDestination(input: ProvisionInput): Promise<ProvisionResult> {
    const region = input.desiredRegion ?? this.preset.defaultRegion();
    const endpoint = this.preset.endpointFor(region);
    const bucket =
      input.desiredBucketName ?? this.defaultBucketName(input.userId);
    const { accessKey, secretKey, reused } =
      await this.ec2Credentials.ensureS3KeyPair();

    const creds = {
      provider: this.provider,
      endpoint,
      region,
      bucket,
      accessKey,
      secretKey,
      forcePathStyle: true,
    };

    const alreadyExisted = (await this.genericS3.testConnection(creds)).healthy;
    if (!alreadyExisted) {
      await this.genericS3.ensureBucket(creds);
    }
    this.logger.log(
      `OVH bucket ${bucket} (${region}) ready — credential ${reused ? 'reused' : 'minted'}, bucket ${alreadyExisted ? 'existing' : 'created'}`,
    );

    return {
      bucket,
      region,
      endpoint,
      forcePathStyle: true,
      pathPrefix: `flui/${input.clusterId}`,
      accessKey,
      secretKey,
      usableForEtcdL1: true,
      alreadyExisted,
    };
  }

  private defaultBucketName(userId: string): string {
    const short = userId.replaceAll('-', '').slice(0, 12).toLowerCase();
    return `flui-backups-${short}`;
  }
}
