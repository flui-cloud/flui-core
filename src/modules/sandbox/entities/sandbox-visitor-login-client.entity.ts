import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

export const VISITOR_LOGIN_CLIENT_ROW = 'default';

/**
 * The identity-provider credential that may sign a visitor in, and nothing
 * else: a machine account holding only the login-client role.
 */
@Entity('sandbox_visitor_login_client')
export class SandboxVisitorLoginClientEntity {
  @PrimaryColumn({ type: 'varchar', length: 32 })
  id: string;

  @Column({ type: 'varchar', length: 64 })
  idpUserId: string;

  @Column({ type: 'text' })
  patEncrypted: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  tokenId: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  /** The "try" applications, kept so their tokens are known after the entrance is shut. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  webClientId: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  cliClientId: string | null;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
