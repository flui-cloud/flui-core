import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * First-class project: a global (cross-cluster) grouping of applications. An app
 * belongs to at most one project (ApplicationEntity.projectId). The IAM selector
 * targets a project by its `slug` (human-friendly in grants/CLI/YAML).
 */
@Entity('projects')
export class ProjectEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 255 })
  slug: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  /** Optional UI accent (hex or token). */
  @Column({ type: 'varchar', length: 32, nullable: true })
  color: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
