import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum WireGuardPeerRole {
  /** A node of the control cluster: it listens, and every member dials it. */
  CONTROL = 'control',
  /** A workload node, which dials out and holds the tunnel open. */
  MEMBER = 'member',
}

export enum WireGuardPeerStatus {
  /** Address allocated and key recorded; no handshake seen yet. */
  PENDING = 'pending',
  ACTIVE = 'active',
  /** Configured, but no handshake within the staleness window. */
  STALE = 'stale',
  /** Withdrawn. Kept as a row so the address is not reused immediately and the
   *  history of a node's keys stays readable. */
  REVOKED = 'revoked',
}

export interface ControlHandshakeReading {
  fresh: boolean;
  /** The latest handshake that control node reported, ISO. */
  at: string | null;
  /** When it was read, ISO: an old reading proves nothing about now. */
  readAt: string;
}

/**
 * One end of the management overlay.
 *
 * Holds public material only: a node generates its own keypair and sends the
 * public half, and the control cluster's private key is an encrypted column
 * elsewhere alongside the SSH CA. Nothing here is a secret, which is what makes
 * it safe to read in a reconcile loop and to render into a config.
 */
@Entity('wg_peers')
@Index('IDX_wg_peers_cluster_status', ['clusterId', 'status'])
@Index('IDX_wg_peers_nodeId', ['nodeId'])
// Partial uniqueness, declared here and not only in the migration: left to the
// migration alone, the next `migration:generate` would happily drop both.
@Index('UQ_wg_peers_live_address', ['managementIp'], {
  unique: true,
  where: '"revokedAt" IS NULL',
})
// Declared here as well as in the migration, for the reason the note above
// gives: an index that lives only in a migration is one the next
// `migration:generate` drops.
@Index('IDX_wg_peers_subnet', ['subnetId'], {
  where: '"subnetId" IS NOT NULL',
})
@Index('UQ_wg_peers_live_node', ['nodeId'], {
  unique: true,
  where: '"revokedAt" IS NULL AND "nodeId" IS NOT NULL',
})
@Index('UQ_wg_peers_live_primary', ['isPrimary'], {
  unique: true,
  where: '"revokedAt" IS NULL AND "isPrimary" = true',
})
export class WireGuardPeerEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Null only on a control row written before every control node became a
   *  peer of its own. */
  @Column({ type: 'uuid', nullable: true })
  nodeId?: string | null;

  @Column({ type: 'uuid' })
  clusterId: string;

  /**
   * The isolation domain this peer belongs to, for a Flui-managed VNet.
   *
   * Copied onto the peer rather than read from the node it belongs to: who may
   * talk to whom is a property of the overlay, and keeping it here lets the
   * topology be computed — and tested — without loading cluster records. Null
   * for the management overlay, where there is only one domain and the control
   * cluster is the only thing anyone peers with.
   */
  @Column({ type: 'uuid', nullable: true })
  subnetId?: string | null;

  @Column({ type: 'enum', enum: WireGuardPeerRole })
  role: WireGuardPeerRole;

  /**
   * The control row on the master: the one whose key is kept sealed so a
   * rebuilt master returns with the same identity, and whose address telemetry
   * is sent to. A flag rather than a lookup of the node's type, because on a
   * rebuild the row has to be found before the new master is known.
   */
  @Column({ type: 'boolean', default: false })
  isPrimary: boolean;

  /**
   * On a member: what each control node's kernel last said about it, keyed by
   * that control row's id. The member's `status` follows the primary alone;
   * this is what proves every other control node reaches it too.
   */
  @Column({ type: 'jsonb', nullable: true })
  controlHandshakes?: Record<string, ControlHandshakeReading> | null;

  /**
   * base64 x25519 public key, 44 characters. Never a private key.
   *
   * Null while the address is reserved but the node has not yet reported its
   * key. The two halves of a peer's identity come from different places and at
   * different times: Flui can assign the address before the machine exists —
   * which is what lets the API server certificate carry it from first boot —
   * but only the node can produce the key.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  publicKey?: string | null;

  /** The `/32` this peer answers on inside the management pool. */
  @Column({ type: 'varchar', length: 45 })
  managementIp: string;

  /** Last known public transport address. Only the listening peer needs one;
   *  for a member it is recorded for diagnostics and firewall allow-lists. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  endpointHost?: string | null;

  @Column({ type: 'int', nullable: true })
  endpointPort?: number | null;

  /** Set only on peers that listen. */
  @Column({ type: 'int', nullable: true })
  listenPort?: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastHandshakeAt?: Date | null;

  /**
   * The master's private key, encrypted. Only the primary control row has one:
   * kept so a rebuilt master comes back with the same identity and no member
   * has to be re-keyed. Other control nodes are re-keyed on a rebuild, which
   * the next sweep carries to every member.
   */
  @Column({ type: 'text', nullable: true, select: false })
  privateKeySealed?: string | null;

  @Column({
    type: 'enum',
    enum: WireGuardPeerStatus,
    default: WireGuardPeerStatus.PENDING,
  })
  status: WireGuardPeerStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  /** Set when the peer is withdrawn. The row stays, and so does its claim on
   *  the address: allocation skips it forever, so a node enrolled later never
   *  inherits the identity of one retired earlier while stale config elsewhere
   *  may still name it. */
  @Column({ type: 'timestamptz', nullable: true })
  revokedAt?: Date | null;
}
