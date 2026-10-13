import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import {
  ImageRegistryMode,
  RegistryStorageBackend,
} from '../flui-registry.config';

export const REGISTRY_SETTING_ID = 'instance';

/**
 * Which registry new builds push to, chosen after install. One row at most;
 * without it the install-time environment decides.
 */
@Entity('registry_settings')
export class RegistrySettingEntity {
  @PrimaryColumn({ type: 'varchar', length: 16 })
  id: string;

  @Column({ type: 'varchar', length: 8 })
  mode: ImageRegistryMode;

  @Column({ type: 'varchar', length: 16 })
  storageBackend: RegistryStorageBackend;

  @Column({ type: 'varchar', length: 64, nullable: true })
  changedByUserId: string | null;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
