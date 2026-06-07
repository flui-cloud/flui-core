import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('assistant_message_logs')
export class AssistantMessageLogEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  user_id: string;

  @Column()
  model: string;

  @Column()
  source: string;

  @Column({ type: 'int' })
  message_count: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
