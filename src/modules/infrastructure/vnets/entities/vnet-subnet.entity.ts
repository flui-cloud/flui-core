import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { VNetEntity } from './vnet.entity';

export enum SubnetType {
  CLOUD = 'cloud',
  SERVER = 'server',
  VSWITCH = 'vswitch',
  MANUAL = 'manual',
}

@Entity('vnet_subnets')
export class VNetSubnetEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  vnetId: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  providerSubnetId?: string;

  @Column({ type: 'varchar', length: 50 })
  ipRange: string;

  @Column({ type: 'enum', enum: SubnetType })
  type: SubnetType;

  @Column({ type: 'varchar', length: 50 })
  networkZone: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  gateway?: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  vswitchId?: string;

  @Column({ type: 'json', default: '[]' })
  attachedServerIds: string[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  // Relations
  @ManyToOne(() => VNetEntity, (vnet) => vnet.subnets, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'vnetId' })
  vnet: VNetEntity;
}
