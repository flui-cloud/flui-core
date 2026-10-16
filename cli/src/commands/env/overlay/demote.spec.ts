jest.mock('chalk', () => {
  const same = (text: string) => text;
  const chalk: any = new Proxy(same, { get: () => chalk });
  return { __esModule: true, default: chalk };
});
jest.mock('../../../lib/resolve-cluster', () => ({
  resolveClusterRef: jest.fn(),
}));
jest.mock('../../../lib/management-network-client', () => ({
  ManagementNetworkClient: { open: jest.fn() },
}));

import EnvOverlayDemote from './demote';
import { resolveClusterRef } from '../../../lib/resolve-cluster';
import { ManagementNetworkClient } from '../../../lib/management-network-client';

const client = { demote: jest.fn(), release: jest.fn() };

async function run(argv: string[]) {
  const lines: string[] = [];
  const log = jest.spyOn(console, 'log').mockImplementation((line) => {
    lines.push(String(line ?? ''));
  });
  const config = {
    bin: 'flui',
    runHook: async () => ({ successes: [], failures: [] }),
  };
  const command = new EnvOverlayDemote(argv, config as any);
  const exit = jest.spyOn(command, 'exit').mockImplementation(((
    code: number,
  ) => {
    throw new Error(`exit ${code}`);
  }) as never);
  let failure: Error | undefined;
  try {
    await command.run();
  } catch (error) {
    failure = error as Error;
  }
  log.mockRestore();
  return { out: lines.join('\n'), exit, failure };
}

describe('flui env overlay demote', () => {
  beforeEach(() => {
    jest.mocked(resolveClusterRef).mockResolvedValue({
      id: 'wl-id',
      name: 'workload-1',
    });
    jest.mocked(ManagementNetworkClient.open).mockReturnValue(client as any);
    client.demote.mockReset();
    client.release.mockReset();
  });

  it('asks for --yes before moving anything', async () => {
    const { out } = await run(['workload-1']);
    expect(resolveClusterRef).toHaveBeenCalledWith('workload-1');
    expect(client.demote).not.toHaveBeenCalled();
    expect(out).toContain('Re-run with --yes');
  });

  it('moves the cluster to its public address with --yes', async () => {
    client.demote.mockResolvedValue({
      clusterId: 'wl-id',
      clusterName: 'workload-1',
      from: '10.250.0.4',
      to: '203.0.113.10',
      changed: true,
      held: true,
    });

    const { out } = await run(['workload-1', '--yes']);

    expect(client.demote).toHaveBeenCalledWith('wl-id');
    expect(out).toContain('moved from 10.250.0.4 to 203.0.113.10');
    expect(out).toContain('held off the Flui network');
  });

  it('says so when the cluster was already there', async () => {
    client.demote.mockResolvedValue({
      clusterId: 'wl-id',
      clusterName: 'workload-1',
      from: '203.0.113.10',
      to: '203.0.113.10',
      changed: false,
      held: true,
    });

    expect((await run(['workload-1', '--yes'])).out).toContain(
      'already on 203.0.113.10',
    );
  });

  it('releases the hold with --release, without asking', async () => {
    client.release.mockResolvedValue({});

    const { out } = await run(['workload-1', '--release']);

    expect(client.release).toHaveBeenCalledWith('wl-id');
    expect(client.demote).not.toHaveBeenCalled();
    expect(out).toContain('no longer held on its public address');
  });

  it('prints the API’s refusal and exits non-zero', async () => {
    client.demote.mockRejectedValue(
      new Error('workload-1 is the control cluster'),
    );

    const { out, exit, failure } = await run(['workload-1', '--yes']);

    expect(out).toContain('Error: workload-1 is the control cluster');
    expect(exit).toHaveBeenCalledWith(1);
    expect(failure?.message).toBe('exit 1');
  });
});
