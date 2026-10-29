import {
  EtcdServer,
  etcdLeaderOf,
  etcdLeaderPlacement,
  etcdMembersOf,
} from './etcd-leader.core';

const IDS = {
  master: '10276657743932975437',
  w1: '9372538179322589801',
  w3: '17855658209131950253',
};
const hex = (id: string) => BigInt(id).toString(16);

const memberList = JSON.stringify({ header: {}, members: [] }).replace(
  '[]',
  `[{"ID":${IDS.master},"name":"lab-master-1a2b3c4d"},{"ID":${IDS.w1},"name":"lab-worker-1-0f9e8d7c"},{"ID":${IDS.w3},"name":"lab-worker-3-aabbccdd"}]`,
);
const status = (leader: string) =>
  `[{"Endpoint":"https://127.0.0.1:2379","Status":{"header":{"member_id":${IDS.master}},"version":"3.6.7","leader":${leader}}}]`;

const servers: EtcdServer[] = [
  { node: 'lab-master', zone: 'fsn1', ready: true },
  { node: 'lab-worker-1', zone: 'nbg1', ready: true },
  { node: 'lab-worker-3', zone: 'hel1', ready: true },
];

const decide = (
  leader: string,
  over: Partial<Parameters<typeof etcdLeaderPlacement>[0]> = {},
) =>
  etcdLeaderPlacement({
    leader: etcdLeaderOf(status(leader)),
    members: etcdMembersOf(memberList),
    servers,
    preferredZones: ['fsn1', 'nbg1'],
    now: Date.parse('2026-10-29T10:00:00Z'),
    ...over,
  });

describe('etcd leader placement', () => {
  it('keeps the 64-bit member ids exact', () => {
    expect(etcdLeaderOf(status(IDS.w3))).toBe(hex(IDS.w3));
    expect(etcdMembersOf(memberList).map((m) => m.id)).toEqual([
      hex(IDS.master),
      hex(IDS.w1),
      hex(IDS.w3),
    ]);
  });

  it('hands a leader in the voting location to a member in a location for data', () => {
    expect(decide(IDS.w3)).toEqual({
      move: true,
      leaderNode: 'lab-worker-3',
      target: hex(IDS.master),
      targetNode: 'lab-master',
    });
  });

  it('leaves a leader already in a location for data alone', () => {
    expect(decide(IDS.w1)).toMatchObject({ move: false });
  });

  it('never moves while a server is down or not yet a member', () => {
    expect(
      decide(IDS.w3, {
        servers: servers.map((s, i) => (i === 0 ? { ...s, ready: false } : s)),
      }),
    ).toMatchObject({ move: false, reason: 'a server is not ready' });
    expect(
      decide(IDS.w3, {
        servers: [
          ...servers,
          { node: 'lab-worker-4', zone: 'fsn1', ready: true },
        ],
      }),
    ).toMatchObject({ move: false });
  });

  it('prefers the name K3s recorded on the node, and waits after a move', () => {
    expect(
      decide(IDS.w3, {
        servers: servers.map((s) =>
          s.node === 'lab-master' ? { ...s, member: 'lab-master-1a2b3c4d' } : s,
        ),
      }),
    ).toMatchObject({ move: true, targetNode: 'lab-master' });
    expect(
      decide(IDS.w3, { lastMovedAt: '2026-10-29T09:50:00Z' }),
    ).toMatchObject({ move: false, reason: 'moved recently' });
  });
});
