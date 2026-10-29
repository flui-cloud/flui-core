import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';
import { resolveClusterRef } from '../../lib/resolve-cluster';

interface ReplicatedVolumesView {
  clusterId: string;
  enabled: boolean;
  storageClass: string;
  storageNodes: string[];
  warnings: string[];
  plan:
    | {
        feasible: true;
        zones: string[];
        storageNodes: string[];
        tieBreakers: string[];
      }
    | { feasible: false; reason: string };
  operation: { id: string; status: string } | null;
}

export default class ClusterReplicatedVolumes extends Command {
  static readonly description =
    'Show whether a cluster offers replicated volumes, or turn them on.\n' +
    'A replicated volume keeps a synchronous copy in a second location, so an\n' +
    'application with one writer comes back there, with its data, when its\n' +
    'server or its location is lost; the third location only votes. The\n' +
    'cluster must be highly available across three locations (flui cluster ha).\n' +
    'With --enable, a node in each location for data sets aside disk space and\n' +
    'the volume engine is installed; existing volumes do not change.\n' +
    'Applications ask for it per volume with replicated: true in flui.yaml.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> workload-cluster-1',
    '<%= config.bin %> <%= command.id %> workload-cluster-1 --enable',
    '<%= config.bin %> <%= command.id %> workload-cluster-1 --enable --nodes workload-cluster-1-worker-1,workload-cluster-1-worker-2 --size 50',
  ];

  static readonly args = {
    cluster: Args.string({
      description: 'Cluster name or id',
      required: true,
    }),
  };

  static readonly flags = {
    enable: Flags.boolean({
      default: false,
      description: 'Turn replicated volumes on',
    }),
    nodes: Flags.string({
      description:
        'The two nodes that hold the copies, comma separated, one in each location for data (default: Flui picks them)',
    }),
    size: Flags.integer({
      min: 5,
      max: 2000,
      description:
        'GiB each of those nodes sets aside from its own disk (default 20)',
    }),
    force: Flags.boolean({
      default: false,
      description:
        'Accept a region Flui has not validated for high availability; its three locations are treated as equal',
    }),
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ClusterReplicatedVolumes);
    const cfg = new ConfigStorage();
    const api = new ApiClient({
      baseUrl: cfg.getApiUrlOrThrow(),
      apiKey: cfg.getApiKeyOrThrow(),
    });
    const cluster = await resolveClusterRef(args.cluster);
    const path = `/infrastructure/clusters/${cluster.id}/replicated-volumes`;

    if (flags.enable) {
      const nodes = flags.nodes
        ?.split(',')
        .map((n) => n.trim())
        .filter(Boolean);
      const started = await api.post<{
        operationId: string;
        storageNodes: string[];
        sizeGiB: number;
      }>(path, {
        ...(nodes?.length ? { nodes } : {}),
        ...(flags.size ? { sizeGiB: flags.size } : {}),
        ...(flags.force ? { force: true } : {}),
      });
      if (flags.json) {
        this.log(JSON.stringify(started, null, 2));
        return;
      }
      this.log('');
      this.log(
        `   ${chalk.bold(args.cluster)}: enabling replicated volumes on ${started.storageNodes.join(' and ')} (${started.sizeGiB} GiB each)`,
      );
      this.log(`   Operation ${started.operationId}`);
      this.log(
        chalk.dim(
          `   Follow it with: flui cluster replicated-volumes ${args.cluster}`,
        ),
      );
      this.log('');
      return;
    }

    const view = await api.get<ReplicatedVolumesView>(path);
    if (flags.json) {
      this.log(JSON.stringify(view, null, 2));
      return;
    }
    this.log('');
    this.log(`   ${chalk.bold(args.cluster)}`);
    if (view.operation) {
      this.log(
        `   ${chalk.yellow('Being enabled')}: operation ${view.operation.id} (${view.operation.status})`,
      );
    } else if (view.enabled) {
      this.log(
        `   ${chalk.green('Replicated volumes on')}: copies on ${view.storageNodes.join(' and ')}`,
      );
      this.log(
        chalk.dim(
          '   A volume asks for it with replicated: true in flui.yaml. An application moves to the other copy only if every volume it mounts is replicated.',
        ),
      );
    } else if (view.plan.feasible) {
      this.log(
        `   Off. Enabling would keep copies on ${view.plan.storageNodes.join(' and ')} (${view.plan.zones.join(', ')}), with ${view.plan.tieBreakers.join(', ')} for the tie-breaking vote.`,
      );
      this.log(
        chalk.dim(
          `   Turn it on: flui cluster replicated-volumes ${args.cluster} --enable`,
        ),
      );
    } else {
      this.log(
        `   Off, and not possible yet: ${(view.plan as { reason: string }).reason}`,
      );
    }
    for (const warning of view.warnings ?? []) {
      this.log(`   ${chalk.yellow('!')} ${warning}`);
    }
    this.log('');
  }
}
