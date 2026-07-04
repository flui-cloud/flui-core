import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  OneToMany,
} from 'typeorm';
import { EncryptionMode } from '../enums/destination-health.enum';
import { BackupEngineClass } from '../enums/backup-engine-class.enum';
import { BackupArtifactLocationEntity } from './backup-artifact-location.entity';

@Entity('backup_artifacts')
@Index('idx_backup_artifacts_velero_name', ['veleroBackupName'])
@Index('idx_backup_artifacts_expires', ['expiresAt'])
export class BackupArtifactEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  backupJobId: string;

  @Column({ type: 'uuid' })
  clusterId: string;

  @Column({ length: 253, nullable: true })
  veleroBackupName?: string;

  @Column({
    type: 'enum',
    enum: BackupEngineClass,
    default: BackupEngineClass.VOLUME,
  })
  engineClass: BackupEngineClass;

  @Column({ length: 64, nullable: true })
  engineRef?: string;

  @Column({ type: 'bigint', nullable: true })
  sizeBytes?: string;

  @Column({ type: 'int', nullable: true })
  itemCount?: number;

  @Column({ type: 'timestamptz', nullable: true })
  expiresAt?: Date;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  manifestSummary: Record<string, any>;

  @Column({
    type: 'enum',
    enum: EncryptionMode,
    default: EncryptionMode.FLUI_MANAGED,
  })
  encryptionMode: EncryptionMode;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  metadata: Record<string, any>;

  @OneToMany(() => BackupArtifactLocationEntity, (loc) => loc.artifact, {
    cascade: true,
  })
  locations: BackupArtifactLocationEntity[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
