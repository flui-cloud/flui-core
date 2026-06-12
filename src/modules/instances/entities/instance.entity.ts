import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { InstanceType } from './instance-type.enum';
import { InstanceStatus } from './instance-status.enum';
import { InstanceOwnership } from './instance-ownership.enum';
import { CloudProvider } from '../../providers/enums/cloud-provider.enum';

@Entity('instances')
export class InstanceEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  userId: string;

  @Column()
  name: string;

  @Column({ nullable: true })
  displayName: string;

  @Column({ type: 'enum', enum: InstanceType })
  type: InstanceType;

  @Column({ type: 'enum', enum: CloudProvider })
  provider: CloudProvider;

  @Column()
  providerId: string;

  @Column({
    type: 'enum',
    enum: InstanceStatus,
    default: InstanceStatus.UNKNOWN,
  })
  status: InstanceStatus;

  @Column()
  dataCenter: string;

  @Column()
  region: string;

  @Column({ nullable: true })
  regionName: string;

  @Column()
  cpuCores: number;

  @Column()
  ramMb: number;

  @Column()
  diskMb: number;

  @Column({ nullable: true })
  osType: string;

  @Column({ type: 'json', nullable: true })
  ipConfig: {
    v4?: {
      ip: string;
      gateway: string;
      netmaskCidr: number;
    };
    v6?: {
      ip: string;
      gateway: string;
      netmaskCidr: number;
    };
  };

  @Column({ nullable: true })
  macAddress: string;

  @Column({ nullable: true })
  productType: string;

  @Column({ nullable: true })
  productName: string;

  @Column({ nullable: true })
  defaultUser: string;

  @Column({ type: 'json', nullable: true })
  additionalIps: string[];

  @Column({ type: 'json', default: '{}' })
  metadata: Record<string, any>;

  /**
   * Computed at list time, not persisted: which installation this machine
   * belongs to relative to the one answering the request.
   */
  ownership?: InstanceOwnership;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @Column({ nullable: true })
  cancelDate: Date;
}
