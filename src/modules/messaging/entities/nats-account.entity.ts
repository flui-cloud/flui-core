import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

/** One application's account on its cluster's NATS: its own subjects and streams, seen by nobody else. */
@Entity('nats_accounts')
export class NatsAccountEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  publicKey: string;

  @Index()
  @Column({ type: 'uuid' })
  clusterId: string;

  @Index({ unique: true })
  @Column({ type: 'uuid' })
  applicationId: string;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  /** Encrypted. Signs the account's users. */
  @Column({ type: 'text' })
  seed: string;

  @Column({ type: 'text' })
  jwt: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
