jest.mock('chalk', () => {
  const same = (text: string) => text;
  const chalk: any = new Proxy(same, { get: () => chalk });
  return { __esModule: true, default: chalk };
});
jest.mock('../../lib/topology/topology-navigator', () => ({
  navigateTopology: jest.fn(),
}));
const storedDashboard = { url: null as string | null };
jest.mock('../../lib/config-storage', () => ({
  ConfigStorage: jest.fn().mockImplementation(() => ({
    getApiUrlOrThrow: () => 'https://api.example.test/api/v1',
    getApiKeyOrThrow: () => 'key',
    getDashboardUrl: () => storedDashboard.url,
  })),
}));
jest.mock('../../lib/browser-callback', () => ({
  openInBrowser: jest.fn(() => true),
}));
const get = jest.fn();
jest.mock('../../lib/api-client', () => ({
  ApiClient: jest.fn().mockImplementation(() => ({ get })),
}));

import { exampleTopology } from '../../../../src/modules/sandbox/stand-in/sandbox-world-topology';
import { ApiClient } from '../../lib/api-client';
import { openInBrowser } from '../../lib/browser-callback';
import { navigateTopology } from '../../lib/topology/topology-navigator';
import Topology from './index';
import TopologyApp from './app';
import TopologyCluster from './cluster';
import TopologyServer from './server';

const QUIET = 1792663200000;

async function run(Cmd: any, argv: string[]) {
  const lines: string[] = [];
  const warnings: string[] = [];
  const config = {
    bin: 'flui',
    runHook: async () => ({ successes: [], failures: [] }),
  };
  const command = new Cmd(argv, config as any);
  jest.spyOn(command, 'log').mockImplementation((line?: unknown) => {
    lines.push(String(line ?? ''));
  });
  jest.spyOn(command, 'warn').mockImplementation((line: unknown) => {
    warnings.push(String(line));
    return line as never;
  });
  let failure: Error | undefined;
  try {
    await command.run();
  } catch (error) {
    failure = error as Error;
  }
  return { out: lines.join('\n'), warnings, failure };
}

describe('flui topology', () => {
  const tty = process.stdout.isTTY;
  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: tty,
      configurable: true,
    });
  });

  beforeEach(() => {
    jest.mocked(openInBrowser).mockClear().mockReturnValue(true);
    get.mockReset().mockResolvedValue({
      ...exampleTopology(QUIET),
      dashboardUrl: 'https://dashboard.example.com/',
    });
    jest.mocked(ApiClient).mockClear();
    jest.mocked(navigateTopology).mockReset();
  });

  it('prints the fleet when not interactive, asking for the platform apps to fold them', async () => {
    const { out } = await run(Topology, ['--no-interactive']);
    expect(get).toHaveBeenCalledWith('/topology?system=1');
    expect(out).toContain('Fleet\n3 clusters · 5 servers');
    expect(out).toContain('Needs attention');
    expect(navigateTopology).not.toHaveBeenCalled();
  });

  it('honours --api-url over the profile', async () => {
    await run(Topology, [
      '--no-interactive',
      '--api-url',
      'http://localhost:3000/api/v1',
    ]);
    expect(ApiClient).toHaveBeenCalledWith({
      baseUrl: 'http://localhost:3000/api/v1',
      apiKey: 'key',
    });
  });

  it('prints a cluster named in any case', async () => {
    const { out } = await run(TopologyCluster, ['PRODUCTION']);
    expect(out.split('\n')[0]).toBe('Fleet › production');
    expect(out).toContain('Storefront');
  });

  it('refuses an ambiguous app with the candidates, and resolves it with --cluster', async () => {
    const { failure } = await run(TopologyApp, ['storefront']);
    expect(failure?.message).toContain('"storefront" matches 2 apps');
    const { out } = await run(TopologyApp, [
      'storefront',
      '--cluster',
      'staging',
    ]);
    expect(out.split('\n')[0]).toBe('Fleet › staging › Storefront');
  });

  it('prints a server', async () => {
    const { out } = await run(TopologyServer, ['production-2']);
    expect(out).toContain('Runs here');
  });

  it('prints the slice of the API response as JSON, platform apps only on request', async () => {
    const { out } = await run(TopologyApp, ['worker', '--json']);
    expect(get).toHaveBeenCalledWith('/topology');
    const body = JSON.parse(out);
    expect(body.app).toMatchObject({
      displayName: 'Worker',
      status: 'warning',
    });
    expect(body.servers.map((s: { nodeName: string }) => s.nodeName)).toEqual([
      'production-3',
    ]);
    await run(TopologyCluster, ['flui-control', '--json', '--system']);
    expect(get).toHaveBeenLastCalledWith('/topology?system=1');
  });

  it('says why the topology could not be read', async () => {
    get.mockRejectedValueOnce(
      new Error('The Flui API at x cannot be reached (ECONNREFUSED).'),
    );
    const { failure } = await run(Topology, ['--no-interactive']);
    expect(failure?.message).toBe(
      'Could not read the topology: The Flui API at x cannot be reached (ECONNREFUSED).',
    );
  });

  describe('--open', () => {
    const asTerminal = (on: boolean) =>
      Object.defineProperty(process.stdout, 'isTTY', {
        value: on,
        configurable: true,
      });

    it('opens the cluster in the dashboard once, then prints it', async () => {
      asTerminal(true);
      const { out } = await run(TopologyCluster, ['production', '--open']);
      const url =
        'https://dashboard.example.com/topology?level=cluster&cluster=example-cluster-1';
      expect(openInBrowser).toHaveBeenCalledTimes(1);
      expect(openInBrowser).toHaveBeenCalledWith(url);
      expect(out.split('\n')[0]).toBe(`Opening ${url}`);
      expect(out).toContain('Fleet › production');
    });

    it('prints the fleet instead of the navigator when it opens it', async () => {
      asTerminal(true);
      const { out } = await run(Topology, ['--open']);
      expect(openInBrowser).toHaveBeenCalledWith(
        'https://dashboard.example.com/topology',
      );
      expect(navigateTopology).not.toHaveBeenCalled();
      expect(out).toContain('Clusters');
    });

    it('only prints the address when not in a terminal or when the browser does not open', async () => {
      asTerminal(false);
      const { out } = await run(TopologyServer, ['production-2', '--open']);
      expect(openInBrowser).not.toHaveBeenCalled();
      expect(out.split('\n')[0]).toBe(
        'Open in the dashboard: https://dashboard.example.com/topology?view=infrastructure&focus=server:example-server-2',
      );
      asTerminal(true);
      jest.mocked(openInBrowser).mockReturnValueOnce(false);
      const again = await run(TopologyApp, [
        'worker',
        '--open',
        '--dashboard-url',
        'http://localhost:4200',
      ]);
      expect(again.out.split('\n')[0]).toBe(
        'Open in the dashboard: http://localhost:4200/topology?level=app&cluster=example-cluster-1&app=example-app-4&focus=app:example-app-4',
      );
    });

    it('says plainly when the API does not tell where the dashboard is', async () => {
      get.mockResolvedValueOnce(exampleTopology(QUIET));
      const { warnings, out } = await run(TopologyCluster, [
        'production',
        '--open',
      ]);
      expect(openInBrowser).not.toHaveBeenCalled();
      expect(warnings[0]).toContain('--dashboard-url <url>');
      expect(out).toContain('Fleet › production');
    });

    it('falls back to the dashboard address the profile recorded', async () => {
      storedDashboard.url = 'https://dash.recorded.test';
      get.mockResolvedValueOnce(exampleTopology(QUIET));
      const { warnings, out } = await run(TopologyCluster, [
        'production',
        '--open',
      ]);
      storedDashboard.url = null;
      expect(warnings).toEqual([]);
      expect(out).toMatch(
        /https:\/\/dash\.recorded\.test\/topology\?level=cluster/,
      );
    });

    it('cannot be asked together with --json', async () => {
      const { failure } = await run(TopologyCluster, [
        'production',
        '--open',
        '--json',
      ]);
      expect(failure?.message).toMatch(/cannot also be provided/);
    });
  });
});
