jest.mock('chalk', () => {
  const same = (text: string) => text;
  return {
    __esModule: true,
    default: { green: same, red: same, yellow: same, dim: same },
  };
});

import { printManagementNetwork } from './management-network-view';
import { ManagementNetwork } from './management-network-client';

const network = (over: Partial<ManagementNetwork> = {}): ManagementNetwork => ({
  enabled: true,
  source: 'install',
  unavailable: null,
  hub: { address: '10.250.0.1', endpoint: '203.0.113.1:51821', keyed: true },
  members: [],
  ...over,
});

describe('the Flui network as the CLI prints it', () => {
  let lines: string[];
  beforeEach(() => {
    lines = [];
    jest.spyOn(console, 'log').mockImplementation((line?: unknown) => {
      lines.push(String(line ?? ''));
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it("says why members stay pending when the control's end is not set up", () => {
    printManagementNetwork(
      network({
        hubProblem:
          "could not read the control cluster's key: Cannot reach node 203.0.113.1:22",
      }),
    );
    expect(lines.join('\n')).toContain('members stay pending');
    expect(lines.join('\n')).toContain('Cannot reach node 203.0.113.1:22');
  });

  it('says nothing about it when the control applies', () => {
    printManagementNetwork(network({ hubProblem: null }));
    expect(lines.join('\n')).not.toContain('members stay pending');
  });

  it('passes on a warning about how the control end is set up', () => {
    printManagementNetwork(
      network({
        hubWarning:
          'FLUI_WG_ENDPOINT_NAME wg.example.org resolves to 2.2.2.2, not to the control master (1.1.1.1) alone',
      }),
    );
    expect(lines.join('\n')).toContain('not to the control master');
    expect(lines.join('\n')).not.toContain('members stay pending');
  });

  it('shows every control node’s end and what it reaches', () => {
    printManagementNetwork(
      network({
        hubs: [
          {
            address: '10.250.0.1',
            endpoint: '203.0.113.1:51821',
            keyed: true,
            nodeId: 'm',
            nodeName: 'ctl-master',
            primary: true,
            status: 'active',
            membersReached: 2,
            membersNotReached: 0,
          },
          {
            address: '10.250.0.2',
            endpoint: '203.0.113.2:51821',
            keyed: true,
            nodeId: 'w',
            nodeName: 'ctl-worker-1',
            primary: false,
            status: 'stale',
            membersReached: 1,
            membersNotReached: 1,
          },
        ],
      }),
    );
    const out = lines.join('\n');
    expect(out).toContain('ctl-master (primary)  10.250.0.1');
    expect(out).toContain('ctl-worker-1  10.250.0.2');
    expect(out).toContain('1 member(s) reached, 1 not');
    expect(out).not.toContain('Control end:');
  });

  it('falls back to the single control end of an older API', () => {
    printManagementNetwork(network());
    expect(lines.join('\n')).toContain('Control end: 10.250.0.1');
  });

  it('says which control node misses a member, and when a person holds it on its public address', () => {
    printManagementNetwork(
      network({
        members: [
          {
            clusterId: 'w',
            clusterName: 'demo',
            nodeName: 'demo-master',
            address: '10.250.0.3',
            status: 'active',
            lastHandshakeAt: null,
            unreachedFrom: ['ctl-worker-1'],
            heldOffOverlay: true,
          },
        ],
      }),
    );
    const out = lines.join('\n');
    expect(out).toContain('not reached from ctl-worker-1');
    expect(out).toContain('held on its public address');
  });
});
