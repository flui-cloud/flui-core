import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Unique,
} from 'typeorm';
import { DnsProvider } from '../../providers/enums/dns-provider.enum';
import { DnsReplicaStatus } from '../enums/dns-replica-status.enum';
import { DnsZoneEntity } from './dns-zone.entity';

@Entity('dns_zone_replicas')
@Unique(['dnsZoneId', 'dnsProvider'])
export class DnsZoneReplicaEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  dnsZoneId: string;

  @ManyToOne(() => DnsZoneEntity, (zone) => zone.replicas, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'dnsZoneId' })
  dnsZone: DnsZoneEntity;

  @Column({ type: 'enum', enum: DnsProvider })
  dnsProvider: DnsProvider;

  // Hetzner: numeric zone id; Scaleway: the zone name.
  @Column({ type: 'varchar' })
  providerZoneId: string;

  @Column({
    type: 'enum',
    enum: DnsReplicaStatus,
    default: DnsReplicaStatus.PENDING,
  })
  status: DnsReplicaStatus;

  @Column({ type: 'timestamptz', nullable: true })
  lastReconciledAt: Date;

  @Column({ type: 'text', nullable: true })
  errorMessage: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
