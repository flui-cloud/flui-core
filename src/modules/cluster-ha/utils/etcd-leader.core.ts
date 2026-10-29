/** K3s records on each server node the name of its etcd member. */
export const ETCD_MEMBER_ANNOTATION = 'etcd.k3s.cattle.io/node-name';

export const ETCD_LEADER_MOVE_COOLDOWN_MS = 30 * 60 * 1000;

export interface EtcdMember {
  /** Hex, the form `etcdctl move-leader` takes. */
  id: string;
  name: string;
}

export interface EtcdServer {
  node: string;
  zone?: string;
  ready: boolean;
  member?: string;
}

export type EtcdLeaderPlacement =
  | { move: false; reason: string }
  | { move: true; leaderNode: string; target: string; targetNode: string };

/** etcd prints member ids as 64-bit integers, more than a JavaScript number holds. */
function parseEtcdJson(text: string): any {
  return JSON.parse(text.replace(/:(\s*)(\d{16,})/g, ':$1"$2"'));
}

const hex = (id: string | number) => BigInt(id).toString(16);

export function etcdLeaderOf(statusJson: string): string | undefined {
  const parsed = parseEtcdJson(statusJson);
  const leader = (Array.isArray(parsed) ? parsed[0] : parsed)?.Status?.leader;
  return leader === undefined ? undefined : hex(leader);
}

export function etcdMembersOf(memberListJson: string): EtcdMember[] {
  return (parseEtcdJson(memberListJson)?.members ?? []).map(
    (m: { ID: string; name: string }) => ({ id: hex(m.ID), name: m.name }),
  );
}

/** The member K3s named after the node: the node's name and eight hex characters. */
export function memberOfServer(
  server: EtcdServer,
  members: EtcdMember[],
): EtcdMember | undefined {
  return members.find((m) =>
    server.member
      ? m.name === server.member
      : /^(.+)-[0-9a-f]{8}$/.exec(m.name)?.[1] === server.node,
  );
}

/**
 * Whether the etcd leader sits outside the locations a write is confirmed
 * fastest from, and which member to hand it to. Only while every server is
 * ready and an etcd member, so leadership never moves in the middle of a loss.
 */
export function etcdLeaderPlacement(input: {
  leader: string | undefined;
  members: EtcdMember[];
  servers: EtcdServer[];
  preferredZones: string[];
  lastMovedAt?: string;
  now: number;
}): EtcdLeaderPlacement {
  if (input.servers.some((s) => !s.ready)) {
    return { move: false, reason: 'a server is not ready' };
  }
  const placed = input.servers.map((s) => ({
    ...s,
    id: memberOfServer(s, input.members)?.id,
  }));
  if (
    placed.some((s) => !s.id) ||
    input.members.length !== input.servers.length
  ) {
    return { move: false, reason: 'servers and members do not match' };
  }
  const leader = placed.find((s) => s.id === input.leader);
  if (!leader?.zone) return { move: false, reason: 'leader not placed' };
  if (input.preferredZones.includes(leader.zone)) {
    return { move: false, reason: 'already in place' };
  }
  if (
    input.lastMovedAt &&
    input.now - Date.parse(input.lastMovedAt) < ETCD_LEADER_MOVE_COOLDOWN_MS
  ) {
    return { move: false, reason: 'moved recently' };
  }
  const target = placed
    .filter((s) => s.zone && input.preferredZones.includes(s.zone))
    .sort((a, b) => a.node.localeCompare(b.node))[0];
  if (!target)
    return { move: false, reason: 'no member in a preferred location' };
  return {
    move: true,
    leaderNode: leader.node,
    target: target.id!,
    targetNode: target.node,
  };
}
