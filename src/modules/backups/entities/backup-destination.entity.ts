import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  Unique,
} from 'typeorm';
import { StorageBackendProvider } from '../../storage/enums/storage-backend-provider.enum';
import {
  DestinationHealthStatus,
  EncryptionMode,
} from '../enums/destination-health.enum';

@Entity('backup_destinations')
@Unique('uq_backup_destinations_user_name', ['userId', 'name'])
@Index('idx_backup_destinations_user', ['userId'])
@Index('idx_backup_destinations_health', ['healthStatus'])
export class BackupDestinationEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ length: 120 })
  name: string;

  @Column({ type: 'enum', enum: StorageBackendProvider })
  provider: StorageBackendProvider;

  @Column({ length: 255 })
  endpoint: string;

  @Column({ length: 64 })
  region: string;

  @Column({ length: 255 })
  bucket: string;

  @Column({ length: 255, nullable: true })
  pathPrefix?: string;

  @Column({ type: 'text' })
  accessKeyEncrypted: string;

  @Column({ type: 'text' })
  secretKeyEncrypted: string;

  @Column({
    type: 'enum',
    enum: EncryptionMode,
    default: EncryptionMode.FLUI_MANAGED,
  })
  encryptionMode: EncryptionMode;

  @Column({ type: 'text', nullable: true })
  encryptionPassphraseEncrypted?: string;

  @Column({ default: false })
  useSse: boolean;

  @Column({ default: true })
  forcePathStyle: boolean;

  @Column({ default: false })
  usableForEtcdL1: boolean;

  // Operator attestation that an opaque (MinIO/generic-S3) destination is NOT hosted on the
  // master's own provider — required to use it for the platform backup class.
  @Column({ default: false })
  offProviderAck: boolean;

  @Column({
    type: 'enum',
    enum: DestinationHealthStatus,
    default: DestinationHealthStatus.UNKNOWN,
  })
  healthStatus: DestinationHealthStatus;

  @Column({ type: 'timestamptz', nullable: true })
  lastHealthCheckAt?: Date;

  @Column({ type: 'text', nullable: true })
  lastHealthError?: string;

  @Column({ type: 'bigint', nullable: true })
  usageBytes?: string;

  @Column({ type: 'timestamptz', nullable: true })
  usageRefreshedAt?: Date;

  @Column({ type: 'int', nullable: true })
  costPerGbMonthCents?: number;

  @Column({ type: 'jsonb', default: {} })
  metadata: Record<string, any>;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
