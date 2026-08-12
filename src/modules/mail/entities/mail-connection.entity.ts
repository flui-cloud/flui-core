import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type MailConnectionScope = 'transactional' | 'bulk';

export type MailConnectionProvider =
  | 'scaleway-tem'
  | 'brevo'
  | 'zeptomail'
  | 'smtp';

/**
 * Where the credential for a connection comes from.
 *
 * Scaleway is the one provider that needs nothing new: Transactional Email
 * rides on the compute secret key the user already connected, the same
 * arrangement object storage and inference use. Everything else is bring your
 * own, and its secret lives on the row.
 */
export type MailCredentialSource = 'scaleway-compute' | 'inline';

/**
 * The non-secret half of a connection's configuration.
 *
 * Deliberately loose: a relay needs a host and a port, ZeptoMail needs its
 * regional API host, Brevo needs nothing at all. Modelling four providers'
 * worth of columns would leave most of them null on every row.
 */
export interface MailConnectionConfig {
  /** ZeptoMail: the regional API host, which **is** the data residency. */
  region?: string;
  /** SMTP relay. */
  host?: string;
  port?: number;
  username?: string;
  secure?: boolean;
  /**
   * Whether this relay may carry bulk. Operator-declared, never deduced — the
   * same code reaches a relay that welcomes newsletters and one whose terms
   * forbid them, and only the operator knows which they pointed it at.
   */
  allowsBulk?: boolean;
  /** SMTP relay: what its own setup page says to publish. Never invented. */
  spfInclude?: string;
  dkimSelector?: string;
  dkimValue?: string;
  /** Brevo/ZeptoMail: the id of the webhook we registered, so we do not duplicate it. */
  webhookId?: string;
  /** Where the provider was told to deliver events, kept so a retry is one click. */
  webhookUrl?: string;
  /**
   * Why there is no webhook, in the words shown to whoever reads the console.
   *
   * Stored rather than recomputed because the reason is only knowable at the
   * moment of the attempt — the provider's refusal, a missing public URL — and
   * a screen that can see the absence but not the cause ends up inventing one.
   */
  webhookNote?: string;
}

/**
 * One configured way of sending mail.
 *
 * **Scope is a single value, and that is the whole point.** Bulk and
 * transactional mail must never share an account, a credential or a sending
 * domain — not as policy but as blast radius: a suspension caused by a
 * newsletter takes the password resets down with it. A `scope` that held a set
 * would make the forbidden arrangement representable, and it would look
 * perfectly legal on every screen. One value per row means using one account
 * for both takes two rows, which is somewhere a check can stand.
 *
 * At most one row per scope is active, so the normal state of a healthy install
 * is *two* connections live at once — Scaleway for transactional, Brevo for
 * bulk — rather than one provider chosen globally.
 *
 * The sending domain lives here rather than only at the provider because the
 * invariant has three legs and this is the one Flui could not otherwise see.
 */
@Entity('mail_connections')
@Index('idx_mail_connections_active', ['scope', 'isActive'])
export class MailConnectionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 32 })
  provider: MailConnectionProvider;

  @Column({ type: 'varchar', length: 16 })
  scope: MailConnectionScope;

  /** What the operator calls it. Free text; never used to resolve anything. */
  @Column({ type: 'varchar', length: 120 })
  label: string;

  /** The domain this connection sends from. Null until onboarding sets one. */
  @Column({ type: 'varchar', length: 253, nullable: true })
  sendingDomain: string | null;

  @Column({ type: 'varchar', length: 32 })
  credentialSource: MailCredentialSource;

  /**
   * AES-256-GCM via `KeyStorageService`, the same envelope the inference
   * connections and API tokens use. Null when `credentialSource` is not
   * `inline` — a Scaleway row holds no secret of its own.
   */
  @Column({ type: 'text', nullable: true })
  encryptedSecret: string | null;

  /**
   * SHA-256 of the plaintext secret.
   *
   * Not for verification — for the invariant. The schema cannot look inside a
   * ciphertext, so "these two scopes are not the same account" can only be
   * checked by comparing fingerprints. Storing the digest rather than the key
   * keeps the check possible without keeping a second copy of the secret.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  secretFingerprint: string | null;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  config: MailConnectionConfig;

  /**
   * The shared secret we hand the provider when registering its webhook, and
   * compare on every call it makes back.
   *
   * Encrypted for the same reason the credential is: anyone holding it can
   * write into the suppression list, which is a way to stop an operator
   * emailing whoever they choose, silently.
   */
  @Column({ type: 'text', nullable: true })
  encryptedWebhookSecret: string | null;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
