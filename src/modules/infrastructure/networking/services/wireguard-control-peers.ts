import { IsNull, Repository } from 'typeorm';
import {
  WireGuardPeerEntity,
  WireGuardPeerRole,
  WireGuardPeerStatus,
} from '../entities/wireguard-peer.entity';
import { WG_DEFAULT_PORT } from '../wireguard-config';

export interface EnsureControlPeerInput {
  clusterId: string;
  publicKey: string;
  endpointHost: string;
  listenPort?: number;
  /** Absent only for a caller that predates per-node control peers: it means
   *  the primary, wherever it is. */
  nodeId?: string;
  primary?: boolean;
}

export interface ControlReading {
  publicKey: string;
  fresh: boolean;
  at?: Date;
}

/** A reading older than this says nothing about whether the path works now. */
export const CONTROL_READING_MAX_AGE_MS = 30 * 60 * 1000;

const MERGE_READING = `COALESCE("controlHandshakes", '{}'::jsonb) || CAST(:patch AS jsonb)`;

/**
 * The control cluster's rows of the peer table: one per control node, the
 * master's marked primary.
 *
 * Every control node listens and every member dials each of them, because the
 * API runs on any control node and a copy on a node a member does not peer
 * with cannot reach that member at all.
 */
export class ControlPeerStore {
  constructor(
    private readonly peers: Repository<WireGuardPeerEntity>,
    private readonly allocate: () => Promise<string>,
  ) {}

  /** Live control rows, the primary first. */
  async all(): Promise<WireGuardPeerEntity[]> {
    const rows = await this.peers.find({
      where: { role: WireGuardPeerRole.CONTROL, revokedAt: IsNull() },
    });
    const primary = pickPrimary(rows);
    return primary ? [primary, ...rows.filter((r) => r !== primary)] : rows;
  }

  async primary(): Promise<WireGuardPeerEntity | null> {
    return pickPrimary(await this.all()) ?? null;
  }

  async byNode(nodeId: string): Promise<WireGuardPeerEntity | null> {
    const row = await this.peers.findOne({
      where: { nodeId, revokedAt: IsNull() },
    });
    return row?.role === WireGuardPeerRole.CONTROL ? row : null;
  }

  async sealedKey(): Promise<string | null> {
    const row = await this.peers
      .createQueryBuilder('p')
      .addSelect('p.privateKeySealed')
      .where('p.role = :role', { role: WireGuardPeerRole.CONTROL })
      .andWhere('p.isPrimary = true')
      .andWhere('p.revokedAt IS NULL')
      .getOne();
    return row?.privateKeySealed ?? null;
  }

  async seal(sealed: string): Promise<void> {
    const primary = await this.primary();
    if (!primary) return;
    await this.peers.update({ id: primary.id }, { privateKeySealed: sealed });
  }

  /**
   * Records one control node's end.
   *
   * The primary row follows the master, including onto a rebuilt one: the
   * address and the sealed key stay, the node and cluster move. Any other
   * node keeps the row it already has, whatever its role — a control worker
   * provisioned while the network was on was reserved a member address, and
   * keeping that address spares the node an interface rebuild.
   */
  async ensure(input: EnsureControlPeerInput): Promise<WireGuardPeerEntity> {
    const primary = input.primary ?? !input.nodeId;
    const existing = primary
      ? await this.primary()
      : await this.peers.findOne({
          where: { nodeId: input.nodeId, revokedAt: IsNull() },
        });
    if (primary && existing && input.nodeId) {
      await this.releaseNode(input.nodeId, existing.id);
    }
    const row =
      existing ??
      (primary && input.nodeId
        ? await this.peers.findOne({
            where: { nodeId: input.nodeId, revokedAt: IsNull() },
          })
        : null);
    if (row) {
      if (row.role !== WireGuardPeerRole.CONTROL) {
        row.role = WireGuardPeerRole.CONTROL;
        row.status = WireGuardPeerStatus.PENDING;
        row.subnetId = null;
      }
      row.clusterId = input.clusterId;
      if (input.nodeId) row.nodeId = input.nodeId;
      row.publicKey = input.publicKey;
      row.endpointHost = input.endpointHost;
      row.listenPort = input.listenPort ?? WG_DEFAULT_PORT;
      if (primary) row.isPrimary = true;
      return this.peers.save(row);
    }
    return this.peers.save(
      this.peers.create({
        clusterId: input.clusterId,
        nodeId: input.nodeId ?? null,
        role: WireGuardPeerRole.CONTROL,
        isPrimary: primary,
        publicKey: input.publicKey,
        managementIp: await this.allocate(),
        endpointHost: input.endpointHost,
        listenPort: input.listenPort ?? WG_DEFAULT_PORT,
        status: WireGuardPeerStatus.PENDING,
      }),
    );
  }

  /**
   * Withdraws every control row but the primary whose node is no longer one of
   * the control cluster's. The primary is never withdrawn here: it is moved to
   * the next master instead, which is what keeps its address and key.
   */
  async revokeDeparted(
    clusterId: string,
    nodeIds: string[],
  ): Promise<WireGuardPeerEntity[]> {
    const keep = new Set(nodeIds);
    const gone = (await this.all()).filter(
      (r) =>
        !r.isPrimary &&
        !(r.clusterId === clusterId && r.nodeId && keep.has(r.nodeId)),
    );
    for (const row of gone) await this.revoke(row);
    return gone;
  }

  /** Up when its config applied and its kernel could be read; never the reverse
   *  of a row that has not been up yet. */
  async markEnd(rowId: string, up: boolean): Promise<void> {
    const row = await this.peers.findOne({ where: { id: rowId } });
    if (!row) return;
    const status = up
      ? WireGuardPeerStatus.ACTIVE
      : row.status === WireGuardPeerStatus.ACTIVE
        ? WireGuardPeerStatus.STALE
        : row.status;
    if (status === row.status) return;
    row.status = status;
    await this.peers.save(row);
  }

  /**
   * What one control node's kernel says about each member, kept on the member.
   * Merged in the database: every control node writes its own key of the same
   * column in the same sweep, and a read-modify-write would drop the others.
   */
  async recordReadings(
    controlRowId: string,
    readings: ControlReading[],
    readAt: Date = new Date(),
  ): Promise<void> {
    for (const reading of readings) {
      const patch = {
        [controlRowId]: {
          fresh: reading.fresh,
          at: reading.at ? reading.at.toISOString() : null,
          readAt: readAt.toISOString(),
        },
      };
      await this.peers
        .createQueryBuilder()
        .update(WireGuardPeerEntity)
        .set({ controlHandshakes: () => MERGE_READING })
        .where('"publicKey" = :publicKey', { publicKey: reading.publicKey })
        .andWhere('"role" = :role', { role: WireGuardPeerRole.MEMBER })
        .andWhere('"revokedAt" IS NULL')
        .setParameter('patch', JSON.stringify(patch))
        .execute();
    }
  }

  /**
   * The control nodes whose end is up and that have not recently seen a fresh
   * handshake from this member. Empty means every control node a copy of the
   * API can run behind reaches it. A control node whose end never came up is
   * left out: no copy is served through it, and counting it would hold every
   * member back on a node that is still being set up.
   */
  async notReaching(
    member: WireGuardPeerEntity,
    now: Date = new Date(),
  ): Promise<WireGuardPeerEntity[]> {
    return (await this.all()).filter(
      (c) => countsForReach(c) && !controlReaches(c, member, now),
    );
  }

  private async releaseNode(nodeId: string, keepId: string): Promise<void> {
    const holder = await this.peers.findOne({
      where: { nodeId, revokedAt: IsNull() },
    });
    if (holder && holder.id !== keepId) await this.revoke(holder);
  }

  private async revoke(row: WireGuardPeerEntity): Promise<void> {
    row.status = WireGuardPeerStatus.REVOKED;
    row.revokedAt = new Date();
    await this.peers.save(row);
  }
}

/** The flagged row; before the flag existed, the one row with no node. */
export function pickPrimary(
  rows: WireGuardPeerEntity[],
): WireGuardPeerEntity | undefined {
  return (
    rows.find((r) => r.isPrimary) ?? rows.find((r) => !r.nodeId) ?? rows[0]
  );
}

/** A control node a member has to be reached from: keyed, and its end up. */
export function countsForReach(control: WireGuardPeerEntity): boolean {
  return !!control.publicKey && control.status === WireGuardPeerStatus.ACTIVE;
}

/** Whether this control node recently saw a fresh handshake from the member. */
export function controlReaches(
  control: WireGuardPeerEntity,
  member: WireGuardPeerEntity,
  now: Date = new Date(),
): boolean {
  const reading = member.controlHandshakes?.[control.id];
  return (
    !!reading?.fresh &&
    now.getTime() - new Date(reading.readAt).getTime() <=
      CONTROL_READING_MAX_AGE_MS
  );
}
