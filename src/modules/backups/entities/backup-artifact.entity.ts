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
@Index('idx_backup_artifacts_application', ['applicationId', 'createdAt'])
export class BackupArtifactEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  backupJobId: string;

  @Column({ type: 'uuid' })
  clusterId: string;

  /**
   * The application this artifact protects, when it protects exactly one.
   * Null for a cluster-wide Velero backup and for the platform dump.
   */
  @Column({ type: 'uuid', nullable: true })
  applicationId?: string;

  /** The PVC, for engines that protect one volume rather than a whole app. */
  @Column({ length: 253, nullable: true })
  volumeName?: string;

  @Column({ length: 253, nullable: true })
  veleroBackupName?: string;

  @Column({
    type: 'enum',
    enum: BackupEngineClass,
    default: BackupEngineClass.VOLUME,
  })
  engineClass: BackupEngineClass;

  /**
   * Which continuous-backup engine produced this, where the class alone does
   * not say. `engineClass` describes the shape of the protection; this names
   * the tool, and a restore years from now needs the tool, not the shape.
   */
  @Column({ type: 'varchar', length: 32, nullable: true })
  engine?: string;

  /**
   * The database server's own version at backup time.
   *
   * A restore installs the catalog slug at whatever tag the seed carries then,
   * and a data directory does not open under a different major. Without this
   * the mismatch is discovered during the recovery instead of before it.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  engineVersion?: string;

  @Column({ length: 64, nullable: true })
  engineRef?: string;

  @Column({ type: 'bigint', nullable: true })
  sizeBytes?: string;

  @Column({ type: 'int', nullable: true })
  itemCount?: number;

  @Column({ type: 'timestamptz', nullable: true })
  expiresAt?: Date;

  @Column({ type: 'jsonb', default: {} })
  manifestSummary: Record<string, any>;

  @Column({
    type: 'enum',
    enum: EncryptionMode,
    default: EncryptionMode.FLUI_MANAGED,
  })
  encryptionMode: EncryptionMode;

  @Column({ type: 'jsonb', default: {} })
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
