import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Persisted, single-use `state` token correlating the "create App from manifest"
 * submission with GitHub's manifest-conversion callback. Stored in the DB (not
 * in-process) so it survives API restarts and is shared across replicas — the
 * callback may land on a different instance than the one that issued it.
 */
@Entity('github_app_manifest_states')
export class GithubAppManifestStateEntity {
  @PrimaryColumn({ type: 'uuid' })
  state: string;

  @Column({ name: 'flui_user_id', type: 'uuid' })
  fluiUserId: string;

  @Column({ name: 'callback_url', type: 'varchar' })
  callbackUrl: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;
}
