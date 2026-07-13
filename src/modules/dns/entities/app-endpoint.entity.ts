import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { ClusterDnsZoneEntity } from './cluster-dns-zone.entity';
import { WildcardCertificateEntity } from './wildcard-certificate.entity';
import { SanCertificateEntity } from './san-certificate.entity';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { DnsRecordType } from '../../providers/interfaces/dns-provider.interface';
import { CertificateStatus } from '../../providers/interfaces/certificate-provider.interface';
import { CertificateProvider } from '../../providers/enums/certificate-provider.enum';
import { ReconciliationStatus } from '../../infrastructure/shared/enums/reconciliation-status.enum';
import { EndpointType } from '../enums/endpoint-type.enum';
import { CertChallenge } from '../enums/cert-challenge.enum';
import { HostnameMode } from '../enums/hostname-mode.enum';
import { EndpointGatewayConfig } from '../interfaces/endpoint-gateway-config.interface';

@Entity('app_endpoints')
@Index(['fqdn'], { unique: true })
export class AppEndpointEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  clusterId: string;

  @ManyToOne(() => ClusterEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'clusterId' })
  cluster: ClusterEntity;

  @Column({ type: 'uuid', nullable: true })
  clusterDnsZoneId: string;

  @ManyToOne(() => ClusterDnsZoneEntity, (zone) => zone.endpoints, {
    nullable: true,
  })
  @JoinColumn({ name: 'clusterDnsZoneId' })
  clusterDnsZone: ClusterDnsZoneEntity;

  @Column({ type: 'uuid', nullable: true })
  applicationId: string;

  @ManyToOne(() => ApplicationEntity, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'applicationId' })
  application: ApplicationEntity;

  /**
   * Discriminator. `public` (default) is the legacy endpoint with public DNS
   * + per-app cert + Ingress. `internal` is reachable only via the
   * cluster-wide ForwardAuth gateway: the DNS A record is the cluster-wide
   * `*.internal.<zone>` wildcard (not created per-app), and the Ingress
   * carries the auth-url annotation pointing to /authz/internal-app.
   */
  @Column({
    type: 'enum',
    enum: EndpointType,
    default: EndpointType.PUBLIC,
  })
  endpointType: EndpointType;

  @Column({
    type: 'enum',
    enum: CertChallenge,
    default: CertChallenge.HTTP_01,
  })
  certChallenge: CertChallenge;

  @Column({
    type: 'enum',
    enum: HostnameMode,
    default: HostnameMode.IP,
  })
  hostnameMode: HostnameMode;

  @Column({ type: 'varchar' })
  fqdn: string;

  @Column({ type: 'varchar' })
  serviceName: string;

  @Column({ type: 'varchar' })
  k8sServiceName: string;

  @Column({ type: 'varchar' })
  k8sNamespace: string;

  @Column({ type: 'int' })
  k8sServicePort: number;

  @Column({ type: 'enum', enum: DnsRecordType, default: DnsRecordType.A })
  dnsRecordType: DnsRecordType;

  @Column({ type: 'varchar', nullable: true })
  dnsRecordValue: string;

  @Column({ type: 'varchar', nullable: true })
  dnsRecordId: string;

  @Column({ type: 'enum', enum: CertificateProvider, nullable: true })
  certificateProvider: CertificateProvider;

  @Column({ type: 'boolean', default: true })
  certificateRequired: boolean;

  @Column({ type: 'enum', enum: CertificateStatus, nullable: true })
  certificateStatus: CertificateStatus;

  @Column({ type: 'text', nullable: true })
  certificateMessage: string;

  @Column({ type: 'timestamptz', nullable: true })
  certificateExpiresAt: Date;

  @Column({ type: 'uuid', nullable: true })
  wildcardCertificateId: string | null;

  @ManyToOne(() => WildcardCertificateEntity, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'wildcardCertificateId' })
  wildcardCertificate: WildcardCertificateEntity | null;

  @Column({ type: 'varchar', nullable: true })
  tlsSecretName: string | null;

  @Column({ type: 'uuid', nullable: true })
  sanCertificateId: string | null;

  @ManyToOne(() => SanCertificateEntity, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'sanCertificateId' })
  sanCertificate: SanCertificateEntity | null;

  @Column({
    type: 'enum',
    enum: ReconciliationStatus,
    default: ReconciliationStatus.PENDING,
  })
  reconciliationStatus: ReconciliationStatus;

  @Column({ type: 'timestamptz', nullable: true })
  lastReconciliationAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  lastSyncedAt: Date | null;

  @Column({ type: 'varchar', nullable: true })
  syncedDomain: string | null;

  @Column({ type: 'text', nullable: true })
  errorMessage: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, string>;

  @Column({ type: 'jsonb', nullable: true })
  gatewayConfig: EndpointGatewayConfig | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
