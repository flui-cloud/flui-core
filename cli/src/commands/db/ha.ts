import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';
import { resolveAppOnAnyCluster } from '../../lib/resolve-app';
import { resolveClusterRef } from '../../lib/resolve-cluster';

interface DatabaseHaView {
  appId: string;
  highlyAvailable: boolean;
  state: {
    cluster: string;
    durability: 'required' | 'preferred';
    instances: number;
    state: 'copying' | 'active' | 'failed';
    since: string;
    detail?: string;
  } | null;
  placement?: {
    primary: { instance: string; zone: string | null } | null;
    copies: Array<{
      instance: string;
      zone: string | null;
      ready: boolean;
      confirms: boolean;
      flushLagMs: number | null;
    }>;
  } | null;
}

const DURABILITY = {
  required:
    'no confirmed write is ever lost; writes wait while no copy can confirm',
  preferred: 'writes go on while a copy is away; it catches up later',
};

type Placement = NonNullable<DatabaseHaView['placement']>;

function copyState(c: Placement['copies'][number]): string {
  if (!c.ready) return chalk.red('not ready');
  return c.confirms ? 'confirms commits' : chalk.yellow('not streaming');
}

function placementLines(p: DatabaseHaView['placement']): string[] {
  if (!p?.primary) return [];
  return [
    `   Primary: ${p.primary.instance} (${p.primary.zone ?? 'no location'})`,
    ...p.copies.map((c) => {
      const lag =
        c.flushLagMs === null
          ? 'nothing written lately'
          : `${c.flushLagMs} ms behind`;
      return `   Copy:    ${c.instance} (${c.zone ?? 'no location'}), ${copyState(c)}, ${lag}`;
    }),
  ];
}

function stateLines(view: DatabaseHaView, ref: string): string[] {
  const s = view.state;
  if (!s) {
    return [
      '   Single instance: if its server is lost, the database is down until it returns or is restored.',
      chalk.dim(`   Make it highly available: flui db ha ${ref} --enable`),
    ];
  }
  if (s.state === 'active') {
    return [
      `   ${chalk.green('Highly available')}: ${s.instances} instances, one per location; survives losing a server or a location`,
      `   Writes: ${DURABILITY[s.durability]}`,
      ...placementLines(view.placement),
    ];
  }
  if (s.state === 'copying') {
    return [
      `   ${chalk.yellow('Being made highly available')}: the copy is catching up; the single instance still serves`,
    ];
  }
  return [
    `   ${chalk.red('The last attempt stopped')}: ${s.detail ?? 'no detail recorded'}`,
  ];
}

export default class DbHa extends Command {
  static readonly description =
    'Show whether a managed PostgreSQL is highly available, or make it so.\n' +
    "With --enable, Flui builds three instances, one in each of the cluster's\n" +
    'three locations, as live copies of the database and moves the application\n' +
    'to them without stopping it: writes pause for a few seconds. A commit waits\n' +
    'for whichever copy answers first. The single instance is kept, stopped, as\n' +
    'the way back. The cluster must be highly available across three locations\n' +
    '(flui cluster ha).';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> postgresql-051f58',
    '<%= config.bin %> <%= command.id %> postgresql-051f58 --enable',
    '<%= config.bin %> <%= command.id %> postgresql-051f58 --enable --durability preferred',
  ];

  static readonly args = {
    app: Args.string({
      description: 'Database application name, slug, or id',
      required: true,
    }),
  };

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description: 'Cluster name or id (default: look the name up everywhere)',
    }),
    enable: Flags.boolean({
      default: false,
      description: 'Make the database highly available',
    }),
    durability: Flags.string({
      options: ['required', 'preferred'],
      default: 'required',
      description: `required: ${DURABILITY.required}; preferred: ${DURABILITY.preferred}`,
    }),
    force: Flags.boolean({
      default: false,
      description:
        'Accept a region Flui has not validated for high availability; its three locations are treated as equal',
    }),
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(DbHa);
    const cfg = new ConfigStorage();
    const api = new ApiClient({
      baseUrl: cfg.getApiUrlOrThrow(),
      apiKey: cfg.getApiKeyOrThrow(),
    });
    const clusterId = flags.cluster
      ? (await resolveClusterRef(flags.cluster)).id
      : undefined;
    const app = await resolveAppOnAnyCluster(args.app, clusterId);
    const path = `/applications/${app.id}/db/high-availability`;

    if (flags.enable) {
      const started = await api.post<{ operationId: string }>(path, {
        durability: flags.durability,
        ...(flags.force && { force: true }),
      });
      if (flags.json) {
        this.log(JSON.stringify(started, null, 2));
        return;
      }
      this.log('');
      this.log(
        `   ${chalk.bold(app.name)}: making it highly available (${flags.durability})`,
      );
      this.log(`   Operation ${started.operationId}`);
      this.log(chalk.dim(`   Follow it with: flui db ha ${args.app}`));
      this.log('');
      return;
    }

    const view = await api.get<DatabaseHaView>(path);
    if (flags.json) {
      this.log(JSON.stringify(view, null, 2));
      return;
    }
    const lines = [
      '',
      `   ${chalk.bold(app.name)}`,
      ...stateLines(view, args.app),
      '',
    ];
    for (const line of lines) this.log(line);
  }
}
