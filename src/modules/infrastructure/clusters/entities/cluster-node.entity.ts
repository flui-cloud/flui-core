import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  BeforeInsert,
} from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { ClusterEntity } from './cluster.entity';

export enum NodeType {
  MASTER = 'master',
  WORKER = 'worker',
}

export enum NodeStatus {
  CREATING = 'creating',
  JOINING = 'joining',
  READY = 'ready',
  ERROR = 'error',
  DELETING = 'deleting',
}

@Entity('infrastructure_cluster_nodes')
export class ClusterNodeEntity {
  @PrimaryColumn('uuid')
  id: string;

  @BeforeInsert()
  generateId() {
    if (!this.id) {
      this.id = uuidv4();
    }
  }

  @Column()
  clusterId: string;

  @Column()
  serverName: string;

  @Column()
  providerResourceId: string; // Server ID from cloud provider

  @Column({ type: 'enum', enum: NodeType })
  nodeType: NodeType;

  @Column({ nullable: true })
  ipAddress?: string;

  @Column({ nullable: true })
  privateIp?: string;

  @Column({ type: 'uuid', nullable: true })
  subnetId?: string;

  @Column()
  provider: string;

  /**
   * Null where the provider has no such notion — a BYOS machine has no region
   * and no size, and writing the provider's own name into these (as the
   * billable intervals do) makes a placeholder look like a shape.
   */
  @Column({ nullable: true })
  region?: string | null;

  @Column({ nullable: true })
  serverType?: string | null;

  /**
   * Null, never 0, when no price is known: on BYOS the machine is the
   * operator's own and a zero would read as "free".
   */
  @Column({
    type: 'decimal',
    precision: 12,
    scale: 6,
    nullable: true,
    // Postgres hands numeric back as a string; without this the declared
    // `number` would be a lie at runtime.
    transformer: {
      to: (value?: number | null): number | null => value ?? null,
      from: (value: string | null): number | null =>
        value === null ? null : Number.parseFloat(value),
    },
  })
  hourlyPriceEur?: number | null;

  @Column({
    type: 'enum',
    enum: NodeStatus,
    default: NodeStatus.CREATING,
  })
  status: NodeStatus;

  @Column({ type: 'json', default: '{}' })
  metadata: Record<string, any>;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @ManyToOne(() => ClusterEntity, (cluster) => cluster.nodes, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'clusterId' })
  cluster: ClusterEntity;
}
