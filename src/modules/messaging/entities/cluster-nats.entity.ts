import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * The NATS operator of one cluster. The seeds sign every account and stay
 * encrypted here: the cluster only ever receives JWTs, which are public.
 */
@Entity('cluster_nats')
export class ClusterNatsEntity {
  @PrimaryColumn({ type: 'uuid' })
  clusterId: string;

  @Column({ type: 'text' })
  operatorSeed: string;

  @Column({ type: 'text' })
  systemAccountSeed: string;

  @Column({ type: 'varchar', length: 64 })
  systemAccount: string;

  /** Kept, not re-signed: a fresh JWT would change the configuration and restart the server. */
  @Column({ type: 'text' })
  operatorJwt: string;

  @Column({ type: 'text' })
  systemAccountJwt: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
