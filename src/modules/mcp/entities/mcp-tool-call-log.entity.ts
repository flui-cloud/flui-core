import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('mcp_tool_call_logs')
export class McpToolCallLogEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  user_id: string;

  @Column()
  tool: string;

  @Column()
  scope: string;

  @Column({ default: false })
  allowed: boolean;

  @Column({ type: 'varchar', nullable: true })
  error: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
