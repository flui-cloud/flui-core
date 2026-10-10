import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ApplicationEntity } from '../../applications/entities/application.entity';

export type RegistryCredentialKind = 'push' | 'pull';

/**
 * What a build pushes with, or a cluster pulls with, for one application. The
 * id is the username; only a hash of the secret is kept, so a read of this
 * table hands nobody a working credential.
 */
@Entity('registry_credentials')
export class RegistryCredentialEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_registry_credentials_application')
  @Column({ type: 'uuid' })
  applicationId: string;

  @ManyToOne(() => ApplicationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'applicationId' })
  application?: ApplicationEntity;

  @Column({ type: 'varchar', length: 8 })
  kind: RegistryCredentialKind;

  @Column({ type: 'varchar', length: 64 })
  secretHash: string;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt: Date | null;
}
