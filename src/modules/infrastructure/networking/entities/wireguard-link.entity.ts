import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum WireGuardLinkState {
  OPEN = 'open',
  /** Withdrawn from the desired state; kept until neither host lists the other. */
  CLOSING = 'closing',
  CLOSED = 'closed',
}

export const WG_LINK_SERVICE_PORT_MIN = 15432;
export const WG_LINK_SERVICE_PORT_MAX = 15531;

/**
 * A temporary direct tunnel between two member nodes of different clusters.
 *
 * The listener accepts on its WireGuard port, the dialer reaches it and holds
 * the path with a keepalive. Neither node's `AllowedIPs` grows beyond the other
 * node's `/32`, and the hub never learns about it. Addresses and keys are read
 * from `wg_peers` at render time, so a re-enrolled node is picked up as is.
 */
@Entity('wg_links')
@Index('UQ_wg_links_owner_live', ['ownerId'], {
  unique: true,
  where: `"state" <> 'closed'`,
})
@Index('IDX_wg_links_listener_open', ['listenerNodeId'], {
  where: `"state" = 'open'`,
})
@Index('IDX_wg_links_dialer_open', ['dialerNodeId'], {
  where: `"state" = 'open'`,
})
export class WireGuardLinkEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 32 })
  purpose: string;

  @Column({ type: 'uuid' })
  ownerId: string;

  @Column({ type: 'uuid' })
  listenerNodeId: string;

  @Column({ type: 'uuid' })
  listenerClusterId: string;

  @Column({ type: 'uuid' })
  dialerNodeId: string;

  @Column({ type: 'uuid' })
  dialerClusterId: string;

  @Column({ type: 'int' })
  listenPort: number;

  /** Port the owner exposes on the listener's overlay address. */
  @Column({ type: 'int' })
  serviceTcpPort: number;

  /** Source address the listener's firewall admits on `listenPort`. */
  @Column({ type: 'varchar', length: 45, nullable: true })
  dialerEgressIp?: string | null;

  @Column({ type: 'varchar', length: 16, default: WireGuardLinkState.OPEN })
  state: WireGuardLinkState;

  @Column({ type: 'text', nullable: true })
  closeReason?: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastHandshakeAt?: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  openedAt?: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  closedAt?: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
