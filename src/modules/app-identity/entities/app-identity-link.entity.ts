import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export interface AppIdentityEnvNames {
  issuer: string;
  clientId: string;
  clientSecret: string;
}

/**
 * An application that signs its users in against a customer's identity
 * install: the client Flui made for it there. The secret lives only in the
 * application's encrypted env.
 */
@Entity('app_identity_links')
export class AppIdentityLinkEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ type: 'uuid' })
  applicationId: string;

  @Index()
  @Column({ type: 'uuid' })
  identityInstallId: string;

  @Column({ type: 'varchar', length: 64 })
  projectId: string;

  @Column({ type: 'varchar', length: 64 })
  clientAppId: string;

  @Column({ type: 'varchar', length: 128 })
  clientId: string;

  @Column({ type: 'varchar', length: 512 })
  issuer: string;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  redirectUris: string[];

  /** The variables the application reads the three values from. */
  @Column({ type: 'jsonb' })
  envNames: AppIdentityEnvNames;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
