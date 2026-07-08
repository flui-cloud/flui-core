import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  OneToMany,
  Index,
} from 'typeorm';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { DnsZoneEntity } from './dns-zone.entity';
import { CertificateProvider } from '../../providers/enums/certificate-provider.enum';
import { ReconciliationStatus } from '../../infrastructure/shared/enums/reconciliation-status.enum';
import { AppEndpointEntity } from './app-endpoint.entity';

@Entity('cluster_dns_zones')
@Index('UQ_cluster_dns_zones_cluster_zone', ['clusterId', 'dnsZoneId'], {
  unique: true,
})
export class ClusterDnsZoneEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  clusterId: string;

  @ManyToOne(() => ClusterEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'clusterId' })
  cluster: ClusterEntity;

  @Column({ type: 'uuid' })
  dnsZoneId: string;

  @ManyToOne(() => DnsZoneEntity, (zone) => zone.clusterAssignments, {
    eager: true,
  })
  @JoinColumn({ name: 'dnsZoneId' })
  dnsZone: DnsZoneEntity;

  @Column({ type: 'enum', enum: CertificateProvider, nullable: true })
  certificateProvider: CertificateProvider;

  @Column({ type: 'varchar', nullable: true })
  acmeEmail: string;

  @Column({ type: 'boolean', default: true })
  wildcardCertificate: boolean;

  @Column({
    type: 'enum',
    enum: ReconciliationStatus,
    default: ReconciliationStatus.PENDING,
  })
  reconciliationStatus: ReconciliationStatus;

  @Column({ type: 'timestamptz', nullable: true })
  lastReconciliationAt: Date;

  @Column({ type: 'text', nullable: true })
  errorMessage: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @OneToMany(() => AppEndpointEntity, (endpoint) => endpoint.clusterDnsZone)
  endpoints: AppEndpointEntity[];
}
