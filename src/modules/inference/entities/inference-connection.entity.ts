import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * A user-supplied, OpenAI-compatible inference endpoint (BYO-key): OpenAI, Gemini,
 * Claude-compat, or any compatible server. Not a provider — pure connection config.
 */
@Entity('inference_connections')
export class InferenceConnectionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  label: string;

  @Column()
  base_url: string;

  @Column()
  encrypted_api_key: string;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  models: string[];

  @Column({ default: false })
  is_default: boolean;

  /**
   * Whose connection this is, and the nullability *is* the model (decision 104).
   *
   * NULL — the installation's: every principal may see it and spend it, and
   * `integration:manage` is what plugs it in or unplugs it. That is what every
   * row written before this column existed already is, which is why nothing
   * needed backfilling.
   *
   * Set — one person's: only she sees it in the list (plus `iam:manage-users`),
   * and only she may spend it. A colleague of her own rung must not reach it by
   * guessing the uuid, so the question is asked where the id is turned into a
   * key, not where the list is drawn.
   *
   * No foreign key to `users` on purpose: decision 92(b) measured what adding
   * one costs with `synchronize` on, and the wanted behaviour when a person
   * leaves is that her connection dies with her rather than becoming the
   * installation's — a delete, not a SET NULL.
   */
  @Column({ name: 'owner_user_id', type: 'uuid', nullable: true })
  owner_user_id: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
