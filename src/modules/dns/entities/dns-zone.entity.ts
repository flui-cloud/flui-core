import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
} from 'typeorm';
import { DnsProvider } from '../../providers/enums/dns-provider.enum';
import { ClusterDnsZoneEntity } from './cluster-dns-zone.entity';
import { DnsZoneReplicaEntity } from './dns-zone-replica.entity';

@Entity('dns_zones')
export class DnsZoneEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Primary replica: Hetzner numeric zone id / Scaleway zone name.
  @Column({ type: 'varchar' })
  providerZoneId: string;

  @Column({ type: 'varchar' })
  zoneName: string;

  @Column({ type: 'enum', enum: DnsProvider })
  dnsProvider: DnsProvider;

  @Column({ type: 'varchar', nullable: true })
  description: string;

  // TTL applied to records Flui writes into this zone. Lowered to a failover
  // value when a redundancy replica is registered; 300 for single-provider zones.
  @Column({ type: 'int', default: 300 })
  recordTtlSeconds: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @OneToMany(() => ClusterDnsZoneEntity, (assignment) => assignment.dnsZone)
  clusterAssignments: ClusterDnsZoneEntity[];

  @OneToMany(() => DnsZoneReplicaEntity, (replica) => replica.dnsZone, {
    eager: true,
  })
  replicas: DnsZoneReplicaEntity[];
}
