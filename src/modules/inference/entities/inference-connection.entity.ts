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

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
