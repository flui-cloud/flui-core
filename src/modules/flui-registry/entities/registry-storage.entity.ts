import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { StorageBackendProvider } from '../../storage/enums/storage-backend-provider.enum';

/**
 * The bucket the instance registry keeps images in, and a credential that is
 * the registry's alone: never the account key, never the backups' credential.
 * One is active at a time; a replaced one is kept until what Flui created for
 * it on the provider has been removed.
 */
@Entity('registry_storage')
@Index('IDX_registry_storage_one_active', ['active'], {
  unique: true,
  where: '"active"',
})
export class RegistryStorageEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 32 })
  provider: StorageBackendProvider;

  @Column({ type: 'varchar', length: 255 })
  endpoint: string;

  @Column({ type: 'varchar', length: 64 })
  region: string;

  @Column({ type: 'varchar', length: 255 })
  bucket: string;

  @Column({ type: 'varchar', length: 255, default: 'zot' })
  prefix: string;

  @Column({ type: 'boolean', default: false })
  forcePathStyle: boolean;

  @Column({ type: 'text' })
  accessKeyEncrypted: string;

  @Column({ type: 'text' })
  secretKeyEncrypted: string;

  @Column({ type: 'text' })
  cachePasswordEncrypted: string;

  /** What Flui created on the provider for this bucket, to remove it later. */
  @Column({ type: 'jsonb', default: {} })
  providerResources: Record<string, string>;

  @Column({ type: 'boolean', default: true })
  active: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
