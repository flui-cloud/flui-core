import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';
import { resolveClusterRef } from '../../lib/resolve-cluster';

interface ClusterHaView {
  level: 'standard' | 'three-locations';
  region: string | null;
  topology: {
    validated: boolean;
    zones: Array<{
      zone: string;
      role: 'data' | 'vote';
      servers: string[];
      dataHosts: string[];
    }>;
  } | null;
  unsupported: string | null;
  servers: { count: number; ready: number; zones: string[] };
  survives: string[];
  doesNotSurvive: string[];
  warnings: string[];
  missing: Array<{ role: 'server' | 'data-host'; zone: string; why: string }>;
  observed?: {
    at: string | null;
    etcdLeader: { node: string | null; zone: string | null } | null;
    roundTrips: Array<{ from: string; to: string; ms: number | null }>;
    reachedThrough: string | null;
    reachableServers: string[];
  };
}

const LEVEL = {
  standard: 'standard',
  'three-locations': 'highly available across three locations',
};

const ROLE = {
  server: 'a server',
  'data-host': 'a node for copies of data',
};

type Role = 'server' | 'data-host';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function headerLine(name: string, view: ClusterHaView): string {
  const region = view.region ? ` (${view.region})` : '';
  const servers = plural(view.servers.count, 'server');
  return `   ${chalk.bold(name)}: ${chalk.cyan(LEVEL[view.level])}, ${servers}${region}`;
}

function zoneLines(view: ClusterHaView): string[] {
  if (!view.topology) return [];
  const width = Math.max(8, ...view.topology.zones.map((z) => z.zone.length));
  return [
    '',
    ...view.topology.zones.map((z) => {
      const servers = z.servers.length
        ? z.servers.join(', ')
        : chalk.red('no server');
      return `   ${z.zone.padEnd(width)} ${servers}${zoneData(z)}`;
    }),
  ];
}

function zoneData(z: { role: 'data' | 'vote'; dataHosts: string[] }): string {
  if (z.role !== 'data') return ', votes only';
  const hosts = z.dataHosts.length
    ? z.dataHosts.join(', ')
    : chalk.red('no node yet');
  return `, copies of data on ${hosts}`;
}

function observedLines(view: ClusterHaView): string[] {
  const o = view.observed;
  const lines: string[] = [];
  if (o?.at) {
    lines.push('', chalk.dim(`   Measured ${new Date(o.at).toLocaleString()}`));
    if (o.etcdLeader?.node) {
      const zone = o.etcdLeader.zone ?? 'no location';
      lines.push(`   Leads the cluster: ${o.etcdLeader.node} (${zone})`);
    }
    for (const t of o.roundTrips) {
      const ms =
        t.ms === null ? chalk.red('no answer') : `${t.ms.toFixed(1)} ms`;
      lines.push(`   ${t.from} to ${t.to}: ${ms}`);
    }
  }
  if (o?.reachedThrough) {
    const others = o.reachableServers.filter((s) => s !== o.reachedThrough);
    const move = others.length ? `, and can move to ${others.join(', ')}` : '';
    lines.push(`   Flui reaches it through ${o.reachedThrough}${move}`);
  }
  return lines;
}

function survivalLines(view: ClusterHaView): string[] {
  return [
    '',
    '   Survives',
    ...view.survives.map((s) => `     ${chalk.green('✓')} ${s}`),
    '   Does not survive',
    ...view.doesNotSurvive.map((s) => `     ${chalk.red('✗')} ${s}`),
  ];
}

function missingLines(name: string, view: ClusterHaView): string[] {
  if (!view.missing.length) return [];
  return [
    '',
    '   Still missing',
    ...view.missing.flatMap((m) => [
      `     + ${ROLE[m.role]} in ${m.zone}`,
      chalk.dim(`       ${m.why}`),
      chalk.dim(
        `       flui cluster ha ${name} --add ${m.role} --location ${m.zone}`,
      ),
    ]),
  ];
}

export default class ClusterHa extends Command {
  static readonly description =
    'Show what a cluster survives with the nodes it has now. Flui offers one\n' +
    'highly available layout: a server in each of three locations of a region\n' +
    'it has validated, copies of data in the two closest, the third voting\n' +
    'only. The command lists each location with its role and what is still\n' +
    'missing. With --add and --location, Flui buys the missing server or node\n' +
    'for data there and joins it with its role; scaling never removes it.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> workload-cluster-1',
    '<%= config.bin %> <%= command.id %> workload-cluster-1 --add server --location hel1',
    '<%= config.bin %> <%= command.id %> workload-cluster-1 --add data-host --location nbg1 --size cx33',
  ];

  static readonly args = {
    cluster: Args.string({ description: 'Cluster name or id', required: true }),
  };

  static readonly flags = {
    add: Flags.string({
      options: ['server', 'data-host'],
      description:
        'Add what the cluster still needs: a server (also runs the control plane and holds a vote) or a node for data',
      dependsOn: ['location'],
    }),
    location: Flags.string({
      description:
        'Where to add it, one of the locations listed under "Still missing"',
      dependsOn: ['add'],
    }),
    size: Flags.string({
      description: "Machine size to buy (default: the cluster's own size)",
      dependsOn: ['add'],
    }),
    force: Flags.boolean({
      default: false,
      description:
        'Accept a region Flui has not validated for high availability; its three locations are treated as equal',
    }),
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ClusterHa);
    const cfg = new ConfigStorage();
    const api = new ApiClient({
      baseUrl: cfg.getApiUrlOrThrow(),
      apiKey: cfg.getApiKeyOrThrow(),
    });
    const cluster = await resolveClusterRef(args.cluster);
    if (flags.add) {
      await this.addNode(api, cluster.id, args.cluster, flags);
      return;
    }
    const view = await api.get<ClusterHaView>(
      `/infrastructure/clusters/${cluster.id}/high-availability`,
    );
    if (flags.json) {
      this.log(JSON.stringify(view, null, 2));
      return;
    }
    const lines = [
      '',
      headerLine(args.cluster, view),
      ...(view.unsupported ? [`   ${chalk.yellow(view.unsupported)}`] : []),
      ...view.warnings.map((w) => `   ${chalk.yellow(w)}`),
      ...zoneLines(view),
      ...observedLines(view),
      ...survivalLines(view),
      ...missingLines(args.cluster, view),
      '',
    ];
    for (const line of lines) this.log(line);
  }

  private async addNode(
    api: ApiClient,
    clusterId: string,
    name: string,
    flags: {
      add?: string;
      location?: string;
      size?: string;
      force: boolean;
      json: boolean;
    },
  ): Promise<void> {
    const started = await api.post<{ operationId: string }>(
      `/infrastructure/clusters/${clusterId}/high-availability/nodes`,
      {
        role: flags.add,
        zone: flags.location,
        ...(flags.size && { serverType: flags.size }),
        ...(flags.force && { force: true }),
      },
    );
    if (flags.json) {
      this.log(JSON.stringify(started, null, 2));
      return;
    }
    this.log('');
    this.log(
      `   ${chalk.bold(name)}: adding ${ROLE[flags.add as Role]} in ${flags.location}`,
    );
    this.log(`   Operation ${started.operationId}`);
    this.log(chalk.dim(`   Follow it with: flui cluster ha ${name}`));
    this.log('');
  }
}
