import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { StorageModule } from '../storage.module';
import { ObjectStoragePresetsService } from './object-storage-presets.service';
import { StorageBackendProvider } from '../enums/storage-backend-provider.enum';
import {
  GenericS3ObjectStoragePreset,
  MinioObjectStoragePreset,
} from '../presets/self-hosted-object-storage.presets';
import { OvhObjectStoragePreset } from '../../providers/implementations/ovh/object-storage/ovh-object-storage.preset';
import { ScalewayObjectStoragePreset } from '../../providers/implementations/scaleway/object-storage/scaleway-object-storage.preset';
import { HetznerObjectStoragePreset } from '../../providers/implementations/hetzner/object-storage/hetzner-object-storage.preset';

/**
 * ProvidersModule assembles this service from five classes that live in four
 * different modules. A missing import there compiles perfectly and then fails
 * at boot, so resolve the graph here rather than trusting the type-checker.
 */
@Module({
  imports: [ConfigModule.forRoot({ ignoreEnvFile: true }), StorageModule],
  providers: [
    OvhObjectStoragePreset,
    ScalewayObjectStoragePreset,
    HetznerObjectStoragePreset,
    {
      provide: ObjectStoragePresetsService,
      useFactory: (
        scaleway: ScalewayObjectStoragePreset,
        ovh: OvhObjectStoragePreset,
        hetzner: HetznerObjectStoragePreset,
        minio: MinioObjectStoragePreset,
        generic: GenericS3ObjectStoragePreset,
      ) =>
        new ObjectStoragePresetsService([
          scaleway,
          ovh,
          hetzner,
          minio,
          generic,
        ]),
      inject: [
        ScalewayObjectStoragePreset,
        OvhObjectStoragePreset,
        HetznerObjectStoragePreset,
        MinioObjectStoragePreset,
        GenericS3ObjectStoragePreset,
      ],
    },
  ],
})
class PresetWiringTestModule {}

describe('object storage preset wiring', () => {
  it('resolves every source through the module graph', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PresetWiringTestModule],
    }).compile();

    const service = moduleRef.get(ObjectStoragePresetsService);
    const presets = service.list();

    expect(presets).toHaveLength(5);
    expect(service.forProvider(StorageBackendProvider.MINIO)?.label).toBe(
      'MinIO (self-hosted)',
    );
    await moduleRef.close();
  });
});
