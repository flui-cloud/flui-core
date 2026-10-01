import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  BeforeInsert,
} from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { ApplicationKind } from '../../applications/enums/application-kind.enum';
import { CatalogAppType } from '../enums/catalog-app-type.enum';
import {
  CatalogManifest,
  CatalogLinks,
  CatalogRatings,
} from '../interfaces/catalog-manifest.interface';

@Entity('catalog_app_definitions')
@Index('UQ_catalog_app_definitions_shared_slug_version', ['slug', 'version'], {
  unique: true,
  where: '"ownerUserId" IS NULL',
})
@Index(
  'UQ_catalog_app_definitions_owned_slug_version',
  ['ownerUserId', 'slug', 'version'],
  { unique: true, where: '"ownerUserId" IS NOT NULL' },
)
export class CatalogAppDefinitionEntity {
  @PrimaryColumn('uuid')
  id: string;

  @BeforeInsert()
  generateId() {
    if (!this.id) {
      this.id = uuidv4();
    }
  }

  @Column({ length: 100 })
  slug: string;

  @Column({ length: 50 })
  version: string;

  /**
   * Null for the shared catalog, which only the seed files write. Set to the
   * user who sent the manifest through `install-from-yaml`: that definition is
   * theirs alone and never listed to anyone else.
   */
  @Column({ type: 'uuid', nullable: true })
  ownerUserId?: string | null;

  @Column({ length: 255 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ length: 100 })
  category: string;

  @Column({
    type: 'enum',
    enum: ApplicationKind,
    default: ApplicationKind.APPLICATION,
  })
  appKind: ApplicationKind;

  @Column({ type: 'enum', enum: CatalogAppType })
  appType: CatalogAppType;

  @Column({ type: 'simple-array', default: '' })
  tags: string[];

  @Column({ length: 100, nullable: true })
  license?: string;

  @Column({ type: 'text', nullable: true })
  iconUrl?: string;

  @Column({ type: 'json', nullable: true })
  links?: CatalogLinks;

  @Column({ type: 'json', nullable: true })
  ratings?: CatalogRatings;

  @Column({ type: 'simple-array', default: '' })
  alternativeTo: string[];

  @Column({ type: 'varchar', length: 10, nullable: true })
  maintainedAt?: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  entrypointPath?: string;

  /**
   * Building-block slugs this app is a client of (mirrors metadata.clientFor).
   * Denormalized to a Postgres text[] column so `GET /catalog/:slug/clients`
   * can resolve via `:slug = ANY(clientFor)` without a jsonb scan.
   */
  @Column({ type: 'text', array: true, default: () => "'{}'" })
  clientFor: string[];

  /**
   * Subset of clientFor: BB slugs for which this app is the recommended/
   * default client. Drives the per-target `isDefault` flag returned by
   * GET /catalog/:slug/clients.
   */
  @Column({ type: 'text', array: true, default: () => "'{}'" })
  clientDefaultFor: string[];

  @Column({ type: 'text' })
  rawYaml: string;

  @Column({ type: 'json' })
  manifest: CatalogManifest;

  @Column({ length: 64 })
  checksum: string;

  @Column({ default: true })
  isPublished: boolean;

  @Column({ default: true })
  isActive: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
