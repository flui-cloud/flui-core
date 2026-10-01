import { Entity, PrimaryColumn, Column, Index, BeforeInsert } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { NodeType } from './cluster-node.entity';

@Entity('infrastructure_node_billable_intervals')
@Index(['clusterId', 'startedAt'])
@Index(['nodeId', 'endedAt'])
@Index('UQ_node_billable_intervals_open_node', ['nodeId'], {
  unique: true,
  where: '"endedAt" IS NULL',
})
export class NodeBillableIntervalEntity {
  @PrimaryColumn('uuid')
  id: string;

  @BeforeInsert()
  generateId() {
    if (!this.id) {
      this.id = uuidv4();
    }
  }

  @Column('uuid')
  clusterId: string;

  @Column('uuid')
  nodeId: string;

  @Column()
  serverName: string;

  @Column({ nullable: true })
  providerResourceId?: string;

  @Column()
  provider: string;

  @Column()
  region: string;

  @Column({ nullable: true })
  location?: string;

  @Column()
  serverType: string;

  @Column({ type: 'enum', enum: NodeType })
  nodeType: NodeType;

  @Column({ type: 'timestamptz' })
  startedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  endedAt?: Date | null;

  @Column({ type: 'json', default: '{}' })
  metadata: Record<string, any>;
}
