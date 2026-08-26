import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@Entity('github_app_installations')
export class GitHubAppInstallationEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'installation_id', type: 'bigint', unique: true })
  installationId: number;

  @Column({ name: 'account_login', type: 'varchar' })
  @Index()
  accountLogin: string;

  @Column({ name: 'account_type', type: 'varchar' })
  accountType: 'User' | 'Organization';

  /**
   * The Flui user this installation was discovered for, or null when nobody
   * has connected it yet. Cached proof only, never an authorization: an
   * installation on an organization serves everyone GitHub says it serves, so
   * reachability is asked of GitHubInstallationAccessService, not of this
   * column. Rows written by the webhook before it stopped guessing carry a
   * GitHub login here instead of a Flui id — never filter on it.
   */
  @Column({ name: 'user_id', type: 'varchar', nullable: true })
  @Index()
  userId: string | null;

  /** Which GitHub account clicked Install. Diagnostic, never an identity. */
  @Column({ name: 'installed_by_login', type: 'varchar', nullable: true })
  installedByLogin: string | null;

  @Column({ name: 'repository_selection', type: 'varchar', default: 'all' })
  repositorySelection: string;

  @Column({ name: 'suspended_at', type: 'timestamptz', nullable: true })
  suspendedAt: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
