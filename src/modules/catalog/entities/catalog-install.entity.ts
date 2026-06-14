import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  BeforeInsert,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { CatalogInstallStatus } from '../enums/catalog-install-status.enum';
import { CatalogAppDefinitionEntity } from './catalog-app-definition.entity';
import { DependencyChoice } from '../interfaces/resolved-dependency.interface';

export interface ResourceOverrides {
  cpu?: { request?: string; limit?: string };
  memory?: { request?: string; limit?: string };
  replicas?: number;
}

@Entity('catalog_installs')
export class CatalogInstallEntity {
  @PrimaryColumn('uuid')
  id: string;

  @BeforeInsert()
  generateId() {
    if (!this.id) {
      this.id = uuidv4();
    }
  }

  @Column('uuid')
  catalogAppDefinitionId: string;

  @ManyToOne(() => CatalogAppDefinitionEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'catalogAppDefinitionId' })
  definition: CatalogAppDefinitionEntity;

  @Index()
  @Column('uuid')
  clusterId: string;

  @Column({ nullable: true })
  userId?: string;

  @Column({ nullable: true })
  userEmail?: string;

  @Column({
    type: 'enum',
    enum: CatalogInstallStatus,
    default: CatalogInstallStatus.PENDING,
  })
  status: CatalogInstallStatus;

  @Column('uuid', { nullable: true })
  operationId?: string;

  @Column({ type: 'json', default: '[]' })
  applicationIds: string[];

  @Column({ type: 'json', default: '{}' })
  userInputs: Record<string, string>;

  @Column({ length: 20, nullable: true })
  authMode?: string;

  @Column({ type: 'json', default: '{}' })
  options: Record<string, boolean>;

  @Column({ type: 'json', default: '[]' })
  dependencyChoices: DependencyChoice[];

  @Column({ type: 'json', default: '[]' })
  dependencyInstallIds: string[];

  @Column({ type: 'json', default: '{}' })
  envOverrides: Record<string, string>;

  @Column({ type: 'json', nullable: true })
  resourceOverrides?: ResourceOverrides;

  @Column({ length: 255 })
  displayName: string;

  @Column({ length: 255, unique: true })
  slug: string;

  @Column({ length: 255, nullable: true })
  requestedDomain?: string;

  @Column({ length: 16, nullable: true })
  requestedCertChallenge?: string;

  @Column({ length: 32, nullable: true })
  requestedCertificateProvider?: string;

  @Column({ length: 16, nullable: true })
  requestedHostnameMode?: string;

  @Column({ length: 255, nullable: true })
  resolvedFqdn?: string;

  @Column({ length: 255, nullable: true })
  oidcAppId?: string;

  @Column({ length: 255, nullable: true })
  oidcProjectId?: string;

  @Column({ default: false })
  skipEndpoint: boolean;

  @Column({ default: false })
  allowMasterPlacement: boolean;

  @Column({ length: 20, nullable: true })
  requestedExposure?: 'public' | 'internal';

  @Column({ type: 'text', nullable: true })
  errorMessage?: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  deletedAt?: Date;
}
