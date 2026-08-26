import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('api_keys')
export class ApiKeyEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * The SHA-256 of the key, never the key. The database column keeps its old
   * name so that no installation has to change shape for this: what changed is
   * what goes into it, and a rename would also have had `synchronize: true`
   * dev databases drop the column and every credential in it.
   */
  @Column({ name: 'key', unique: true })
  keyHash: string;

  @Column()
  name: string;

  @Column({ default: false })
  revoked: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ nullable: true, type: 'timestamptz' })
  expiresAt: Date;

  @Column({ nullable: true, type: 'varchar' })
  userId: string | null;

  /** Granted scopes for non-interactive agent tokens (e.g. MCP). Null = no scoped grant. */
  @Column({ type: 'simple-array', nullable: true })
  scopes: string[] | null;

  /**
   * When this key last authenticated a request, to the nearest minute.
   *
   * Null means "not seen since this column existed", which is deliberately not
   * the same claim as "never used" — the column was added after these rows
   * were. Written by `ApiKeyStrategy` behind the threshold in
   * `ApiKeyService.touch`; see the note there for why it is not per request.
   */
  @Column({ nullable: true, type: 'timestamptz' })
  lastUsedAt: Date | null;

  /**
   * The version of the agent skill whoever holds this key last said they were
   * working from.
   *
   * One value, overwritten in place, and that is the whole design: the question
   * is "what is the thing on the other end reading right now", not "what has it
   * read since March". A history of check-ins would be a movement log of
   * somebody's agent kept in a table nobody audits, and the register that
   * legitimately records what an agent *did* already exists elsewhere.
   *
   * Null means the holder has never announced itself, which is a different
   * statement from "an old version": an agent that has never checked in may
   * still be calling tools happily with no instructions at all.
   */
  @Column({ nullable: true, type: 'varchar' })
  skillVersion: string | null;
}
