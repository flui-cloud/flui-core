import { Command, Args, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';
import { listClusters } from '../../lib/cluster-listing';
import { getRecommendedServerType } from '../../config/defaults';

const POLL_INTERVAL_MS = 5000;
// The API waits for the install to end too, and gives a creation up to an hour.
const MAX_WAIT_MS = 3_600_000;

/** The sizes asked for, in order; the node size alone when none were. */
function sizesOf(raw: string | undefined, nodeSize: string): string[] {
  const sizes = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return sizes.length ? sizes : [nodeSize];
}

function nodeLines(plan: HaPlan | null, workerCount: number): string[] {
  if (!plan) return [`  ${chalk.bold('Worker nodes:')} ${workerCount}`];
  const width = Math.max(
    6,
    ...plan.servers.map((s) => s.zone.length),
    ...plan.later.map((zone) => zone.length),
  );
  return [
    `  ${chalk.bold('Availability:')} three locations (${plan.region})`,
    ...plan.servers.map((s) => {
      const role = s.role === 'data' ? 'copies of data' : 'votes';
      const first = s.first ? ', starts the cluster' : '';
      return `                ${s.zone.padEnd(width)} ${s.shape.padEnd(8)} ${role}${first}`;
    }),
    ...plan.later.map(
      (zone) =>
        `                ${zone.padEnd(width)} ${chalk.yellow('none available now: add it later')}`,
    ),
    ...(plan.measured === false
      ? [
          chalk.dim(
            '                The provider declares these as close zones of one region; Flui has not measured them yet.',
          ),
        ]
      : []),
  ];
}

function haRequest(
  ha: boolean,
  sizes: string[],
  completeLater: boolean,
): Record<string, unknown> {
  if (!ha) return {};
  return {
    highAvailability: 'three-locations',
    shapes: sizes,
    ...(completeLater ? { completeLater: true } : {}),
  };
}

interface HaPlan {
  region: string;
  measured?: boolean;
  servers: Array<{
    zone: string;
    shape: string;
    role: 'data' | 'vote';
    first: boolean;
  }>;
  later: string[];
}

export default class ClusterCreate extends Command {
  static readonly description =
    "Create a workload cluster. Defaults to the control cluster's provider " +
    'and region, and attaches to its environment VNet automatically when the ' +
    'provider needs one. Pass --provider to place it elsewhere: the API allows ' +
    'that only when the control cluster permits cross-provider workloads.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-workload',
    '<%= config.bin %> <%= command.id %> my-workload --node-size d2-4 --worker-count 2',
    '<%= config.bin %> <%= command.id %> my-workload --no-wait',
    '<%= config.bin %> <%= command.id %> edge --provider hetzner --region hel1',
    '<%= config.bin %> <%= command.id %> edge --provider byos --flui-network',
    '<%= config.bin %> <%= command.id %> edge --vnet 3f2a… --subnet 9c1b…',
    '<%= config.bin %> <%= command.id %> ha-hz --ha --region fsn1 --sizes cpx22,cx23',
  ];

  static readonly args = {
    name: Args.string({
      description: 'Cluster name (must be unique)',
      required: true,
    }),
  };

  static readonly flags = {
    'node-size': Flags.string({
      description:
        'Server type for cluster nodes. Defaults to the provider recommended size.',
    }),
    region: Flags.string({
      description:
        "Region/location code. Defaults to the control cluster's own region.",
    }),
    'worker-count': Flags.integer({
      description: 'Number of worker nodes (0 = master-only)',
      default: 0,
    }),
    provider: Flags.string({
      description:
        "Provider for the workload cluster. Defaults to the control cluster's " +
        'own. A different one is only accepted when the control cluster permits ' +
        'cross-provider workloads (the API refuses it otherwise).',
    }),
    'flui-network': Flags.boolean({
      description:
        'No-op: on a provider that offers no private network of its own, Flui ' +
        'builds one either way — every node gets an address on an encrypted ' +
        'mesh and K3s binds to it, so traffic between pods stops crossing the ' +
        'internet in the clear. On a provider that has one, Flui uses that.',
      default: false,
    }),
    'network-cidr': Flags.string({
      description:
        'Range for the network Flui builds, if the default would collide with ' +
        'something you already run. Defaults to 10.250.0.0/16.',
    }),
    vnet: Flags.string({
      description:
        'Attach the cluster to an existing private network (see `flui network list`).',
    }),
    subnet: Flags.string({
      description:
        'Subnet within --vnet. Defaults to the network’s only subnet.',
    }),
    'no-wait': Flags.boolean({
      description: 'Return immediately after queuing creation',
      default: false,
    }),
    ha: Flags.boolean({
      description:
        'Highly available across three locations: one server in each location ' +
        'the provider validated for this region, bought together and joined one ' +
        "at a time. --region is the first server's location, one for data.",
      default: false,
    }),
    sizes: Flags.string({
      description:
        'With --ha: the sizes each location may take, comma separated, in order ' +
        'of preference. Each location gets the first one it has available. ' +
        'Defaults to --node-size.',
      dependsOn: ['ha'],
    }),
    'complete-later': Flags.boolean({
      description:
        'With --ha: when a location has none of the sizes available, create the ' +
        'cluster in the others and add that server later. Off, nothing is bought.',
      default: false,
      dependsOn: ['ha'],
    }),
  };

  private refuseWorkersWithHa(ha: boolean, workerCount: number): void {
    if (!ha || workerCount === 0) return;
    this.error(
      'A cluster across three locations starts with its three servers; add workers once it is ready.',
      { exit: 1 },
    );
  }

  private async ensureNameFree(
    apiClient: ApiClient,
    name: string,
    provider: string,
  ): Promise<void> {
    const spinner = ora(`Checking "${name}" is free on ${provider}...`).start();
    let taken: string | null = null;
    try {
      const availability = await apiClient.get<{
        available: boolean;
        reason?: string;
      }>(
        `/infrastructure/clusters/name-availability?name=${encodeURIComponent(name)}&provider=${encodeURIComponent(provider)}`,
      );
      if (availability.available) spinner.succeed('Name available');
      else taken = availability.reason ?? 'Name not available';
    } catch (error: any) {
      // Best-effort — the create call re-validates server-side regardless.
      spinner.warn(
        `Could not pre-check name availability: ${error.message} — continuing`,
      );
    }
    if (taken) {
      // Outside the try: oclif's exit is an exception the catch would swallow.
      spinner.fail(taken);
      this.exit(1);
    }
  }

  private async haPlan(
    apiClient: ApiClient,
    ha: boolean,
    query: {
      provider: string;
      region: string;
      shapes: string[];
      completeLater: boolean;
    },
  ): Promise<HaPlan | null> {
    if (!ha) return null;
    const params = new URLSearchParams({
      provider: query.provider,
      region: query.region,
      shapes: query.shapes.join(','),
      completeLater: String(query.completeLater),
    });
    const plan = await apiClient.get<
      HaPlan & {
        layoutAvailable: boolean;
        possible: boolean;
        refusal: string | null;
      }
    >(`/infrastructure/clusters/high-availability/plan?${params}`);
    if (!plan.possible) {
      this.error(
        plan.refusal ??
          'This cluster cannot be created across three locations.',
        {
          exit: 1,
        },
      );
    }
    return plan;
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ClusterCreate);

    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKeyOrThrow();
    const apiClient = new ApiClient({ baseUrl: apiUrl, apiKey });

    // The control cluster only supplies the defaults: whether a given
    // workload/control provider pair is allowed is the API's decision.
    const { clusters, apiError } = await listClusters();
    if (apiError) {
      this.error(
        `Could not reach the API to find the control cluster: ${apiError}`,
        {
          exit: 1,
        },
      );
    }
    const control = clusters.find((c) =>
      ['control', 'observability'].includes(
        String(c.clusterType).toLowerCase(),
      ),
    );
    if (!control?.provider) {
      this.error(
        'No control cluster found — a workload cluster needs one to attach to.',
        { exit: 1 },
      );
    }

    const provider = flags.provider ?? control.provider;
    const region =
      flags.region ??
      (provider === control.provider ? (control.region ?? '') : '');
    if (
      flags.provider &&
      flags.provider !== control.provider &&
      !flags.region
    ) {
      this.warn(
        `No --region given for ${provider}; the control cluster's region ` +
          `("${control.region ?? 'unset'}") does not apply to another provider, ` +
          `so the provider default will be used.`,
      );
    }
    const verdict = await apiClient
      .get<{
        allowed: boolean;
        reason: string | null;
      }>(
        `/infrastructure/clusters/workload-providers/${encodeURIComponent(provider)}`,
      )
      .catch(() => null);
    if (verdict && !verdict.allowed) {
      this.error(
        verdict.reason ??
          `A workload cluster on ${provider} cannot be created on this installation.`,
        { exit: 1 },
      );
    }

    const nodeSize =
      flags['node-size'] ?? getRecommendedServerType(provider, region);

    const fluiNetwork = flags['flui-network'] || !!flags['network-cidr'];
    if (fluiNetwork && flags.vnet) {
      this.error(
        'Choose one: --vnet attaches to a network that already exists, and ' +
          '--network-cidr sets the range of the one Flui builds.',
        { exit: 1 },
      );
    }
    if (flags.subnet && !flags.vnet) {
      this.error('--subnet needs the --vnet it belongs to.', { exit: 1 });
    }
    this.refuseWorkersWithHa(flags.ha, flags['worker-count']);
    const sizes = sizesOf(flags.sizes, nodeSize);

    await this.ensureNameFree(apiClient, args.name, provider);

    const haPlan = await this.haPlan(apiClient, flags.ha, {
      provider,
      region,
      shapes: sizes,
      completeLater: flags['complete-later'],
    });

    console.log('');
    console.log(`  ${chalk.bold('Name:')}         ${args.name}`);
    console.log(`  ${chalk.bold('Provider:')}     ${provider}`);
    console.log(
      `  ${chalk.bold('Region:')}       ${region || '(provider default)'}`,
    );
    console.log(`  ${chalk.bold('Node size:')}    ${sizes.join(', ')}`);
    for (const line of nodeLines(haPlan, flags['worker-count'])) {
      console.log(line);
    }
    if (fluiNetwork) {
      console.log(
        `  ${chalk.bold('Network:')}      built by Flui ` +
          `(${flags['network-cidr'] ?? 'default range'})`,
      );
    } else if (flags.vnet) {
      console.log(`  ${chalk.bold('Network:')}      ${flags.vnet}`);
    }
    console.log('');

    const createSpinner = ora('Queuing cluster creation...').start();
    let operationId: string;
    let clusterId: string;
    try {
      const result = await apiClient.post<{
        operation_id: string;
        resource_id: string;
        cluster_id: string;
        status: string;
        estimated_duration: string;
      }>('/infrastructure/clusters', {
        name: args.name,
        provider,
        region,
        nodeSize: sizes[0],
        workerCount: flags['worker-count'],
        ...haRequest(flags.ha, sizes, flags['complete-later']),
        ...(fluiNetwork
          ? {
              fluiManagedNetwork: flags['network-cidr']
                ? { ipRange: flags['network-cidr'] }
                : {},
            }
          : {}),
        ...(flags.vnet
          ? {
              vnetConfig: {
                vnetId: flags.vnet,
                ...(flags.subnet ? { subnetId: flags.subnet } : {}),
              },
            }
          : {}),
      });
      operationId = result.operation_id;
      clusterId = result.cluster_id;
      createSpinner.succeed('Creation queued');
      console.log('');
      console.log(`  ${chalk.bold('Cluster ID:')}   ${clusterId}`);
      console.log(`  ${chalk.bold('Operation ID:')} ${operationId}`);
      console.log(
        `  ${chalk.bold('Estimated:')}    ${result.estimated_duration}`,
      );
      console.log('');
    } catch (error: any) {
      createSpinner.fail('Failed to queue creation');
      const msg = error.response?.data?.message ?? error.message;
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }

    if (flags['no-wait']) {
      console.log(
        chalk.dim(
          `  Use \`flui env logs\` or \`flui cluster list\` to check status.\n`,
        ),
      );
      return;
    }

    await this.waitForCreation(apiClient, operationId, args.name, MAX_WAIT_MS);
  }

  private async waitForCreation(
    apiClient: ApiClient,
    operationId: string,
    clusterName: string,
    maxWaitMs: number,
  ): Promise<void> {
    console.log(
      chalk.dim(
        `  Waiting for creation to complete (up to ${maxWaitMs / 60000} min)…`,
      ),
    );
    const waitSpinner = ora('Creating cluster…').start();
    const started = Date.now();

    while (Date.now() - started < maxWaitMs) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const result = await this.pollOperation(
        apiClient,
        operationId,
        clusterName,
        waitSpinner,
      );
      if (result === 'failed') this.exit(1);
      if (result === 'completed') return;
    }

    waitSpinner.warn('Timed out waiting for creation');
    console.log(
      chalk.yellow(`\n  Operation is still running. Check status with:`),
    );
    console.log(chalk.dim(`    flui env logs --operation ${operationId}\n`));
  }

  private async pollOperation(
    apiClient: ApiClient,
    operationId: string,
    clusterName: string,
    waitSpinner: ReturnType<typeof ora>,
  ): Promise<'completed' | 'failed' | 'pending'> {
    try {
      const op = await apiClient.get<{
        status: string;
        currentStepIndex: number;
        totalSteps: number;
        metadata?: any;
      }>(`/infrastructure/operations/${operationId}`);
      const pct =
        op.totalSteps > 0
          ? Math.round((op.currentStepIndex / op.totalSteps) * 100)
          : 0;
      waitSpinner.text = `Creating cluster… ${pct}% (step ${op.currentStepIndex}/${op.totalSteps})`;

      if (op.status === 'COMPLETED') {
        waitSpinner.succeed(chalk.green(`Cluster "${clusterName}" created`));
        return 'completed';
      }
      // Exiting here would throw oclif's ExitError into the catch below, which
      // swallows it as a polling failure and keeps retrying until the timeout.
      if (op.status === 'FAILED') {
        waitSpinner.fail('Creation failed');
        const msg = op.metadata?.error ?? 'Unknown error';
        console.log(chalk.red(`\n  Error: ${msg}\n`));
        return 'failed';
      }
    } catch {
      /* polling error — keep trying */
    }
    return 'pending';
  }
}
