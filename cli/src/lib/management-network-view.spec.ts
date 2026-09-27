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
});
