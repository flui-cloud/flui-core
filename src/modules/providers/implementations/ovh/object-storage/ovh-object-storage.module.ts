import { Module } from '@nestjs/common';
import { StorageModule } from '../../../../storage/storage.module';
import { StorageBackendProvider } from '../../../../storage/enums/storage-backend-provider.enum';
import {
  OBJECT_STORAGE_PROVISIONER_REGISTRY,
  ObjectStorageProvisionerRegistration,
  multiProvisionerProvider,
} from '../../../../storage/tokens/object-storage-provisioner-registry.token';
import { OvhProviderModule } from '../ovh-provider.module';
import { OvhEc2CredentialsService } from './ovh-ec2-credentials.service';
import { OvhObjectStorageProvisioner } from './ovh-object-storage.provisioner';
import { OvhObjectStoragePreset } from './ovh-object-storage.preset';

/**
 * Adds automatic provisioning of OVH Object Storage. The S3 key pair is derived
 * from the stored OpenStack credential, so unlike Hetzner this needs no
 * separate connect step.
 *
 * Import in ProvidersModule (API), NOT in CliProvidersModule.
 */
@Module({
  imports: [StorageModule, OvhProviderModule],
  providers: [
    OvhObjectStoragePreset,
    OvhEc2CredentialsService,
    OvhObjectStorageProvisioner,

    multiProvisionerProvider({
      provide: OBJECT_STORAGE_PROVISIONER_REGISTRY,
      useFactory: (
        p: OvhObjectStorageProvisioner,
      ): ObjectStorageProvisionerRegistration => ({
        provider: StorageBackendProvider.OVH_OBJECT_STORAGE,
        provisioner: p,
      }),
      inject: [OvhObjectStorageProvisioner],
      multi: true,
    }),
  ],
  exports: [
    OvhObjectStoragePreset,
    OvhEc2CredentialsService,
    OvhObjectStorageProvisioner,
    OBJECT_STORAGE_PROVISIONER_REGISTRY,
  ],
})
export class OvhObjectStorageModule {}
