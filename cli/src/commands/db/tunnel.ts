import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { getNestApp, closeNestApp } from '../../lib/nest-app';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';
import { CliAppService } from '../../lib/services/cli-app.service';
import { listClusters, ClusterSummary } from '../../lib/cluster-listing';
import { CliSshService } from '../../services/cli-ssh.service';
import { readDbPassword } from '../../lib/db-secret';
import { engineProfile, CliEngineProfile } from '../../lib/db-engine';

interface DbConnectionInfo {
  engine: string;
  database: string;
  user: string;
  namespace: string;
  podLabelSelector: string;
  clusterId: string;
  remotePort: number;
}

export default class DbTunnel extends Command {
  static readonly description =
    'Open a local tunnel to a Flui database so you can connect a native client\n' +
    '(psql/pgAdmin for Postgres, mariadb/DBeaver for MariaDB, an ORM). Flui databases\n' +
    'are not exposed outside the\n' +
    'cluster network — this forwards through the control plane over SSH + in-cluster\n' +
    'port-forward, so no public endpoint is opened. Stay in foreground; CTRL-C to close.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> postgresql-051f58',
    '<%= config.bin %> <%= command.id %> postgresql-051f58 --local-port 5544',
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
      description:
        'Cluster name or ID (default: auto-detect when only one exists)',
    }),
    'local-port': Flags.integer({
      description:
        'Local port to bind on 127.0.0.1 (default: 55432 for Postgres, 53306 for MariaDB)',
    }),
    retry: Flags.boolean({
      description:
        'Reconnect automatically if the SSH session drops. Disable with --no-retry.',
      default: true,
      allowNo: true,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(DbTunnel);
    const spinner = ora('Resolving database...').start();

    try {
      const { clusters, apiError } = await listClusters();
      const cluster = this.pickCluster(clusters, flags.cluster, apiError);
      const appService = await CliAppService.create(cluster.id);
      const app = await appService.getAppByName(args.app);

      // Coordinates + owner credentials (admin, audited server-side).
      const configStorage = new ConfigStorage();
      const apiUrl = configStorage.getApiUrlOrThrow();
      const apiKey = configStorage.getApiKey();
      if (!apiKey) {
        spinner.fail('Not logged in. Run `flui auth login` first.');
        this.exit(1);
        return;
      }
      const api = new ApiClient({ baseUrl: apiUrl, apiKey });
      const info = await api.get<DbConnectionInfo>(
        `/applications/${app.id}/db/connection-info`,
      );
      const profile = engineProfile(info.engine);
      const localPort = flags['local-port'] ?? profile.defaultLocalPort;

      // The DB may live on a different cluster than the one used to list apps.
      const dbCluster =
        info.clusterId === cluster.id
          ? cluster
          : clusters.find((c) => c.id === info.clusterId);
      if (!dbCluster) {
        spinner.fail(
          `Cluster hosting ${app.slug} (${info.clusterId}) not found`,
        );
        this.exit(1);
        return;
      }
      const masterIp =
        dbCluster.masterIpAddress ??
        dbCluster.nodes?.find((n) => n.nodeType === 'master')?.ipAddress;
      if (!masterIp) {
        spinner.fail(`Master IP not available for cluster ${dbCluster.name}`);
        this.exit(1);
        return;
      }
      spinner.succeed(`${app.slug} → ${dbCluster.name} (${info.namespace})`);

      const remoteCommand = this.buildRemoteCommand(
        info.namespace,
        info.podLabelSelector,
        localPort,
        info.remotePort,
      );

      const app2 = await getNestApp();
      const sshService = app2.get(CliSshService);

      // Password comes straight from the cluster Secret over SSH — never from the API.
      const password = await readDbPassword(
        sshService,
        masterIp,
        info.namespace,
        app.slug,
        profile.secretPasswordKeys,
      );

      let attempt = 0;
      let userExit = false;
      const onSigint = () => {
        userExit = true;
      };
      process.on('SIGINT', onSigint);

      try {
        while (!userExit) {
          attempt += 1;
          if (attempt > 1) {
            console.log(
              chalk.yellow(`\n↻ Reconnecting (attempt ${attempt})...\n`),
            );
          } else {
            console.log(
              chalk.cyan(
                `\n🔌 Opening tunnel to ${masterIp}. Press CTRL-C to close.\n`,
              ),
            );
          }
          const result = await sshService.sshForward({
            host: masterIp,
            forwards: [{ localPort, remotePort: localPort }],
            remoteCommand,
            expectedForwardLines: 1,
            onReady: () =>
              this.printConnection(info, password, localPort, profile),
          });
          if (userExit || !flags.retry) break;
          console.log(
            chalk.yellow(
              `SSH session ended (status=${result.status}, signal=${result.signal}).`,
            ),
          );
          await new Promise((r) => setTimeout(r, 2000));
        }
      } finally {
        process.off('SIGINT', onSigint);
      }
    } catch (error) {
      spinner.fail('Failed to open tunnel');
      console.error(chalk.red(`\n❌ ${(error as Error).message}\n`));
      this.exit(1);
    } finally {
      await closeNestApp();
    }
  }

  // Dashboard-created workload clusters exist only in the control cluster's
  // database, so resolve against the API-merged listing — the local store holds
  // only the clusters this CLI created.
  private pickCluster(
    clusters: ClusterSummary[],
    wanted: string | undefined,
    apiError: string | undefined,
  ): ClusterSummary {
    const available = () =>
      clusters.map((c) => `  • ${c.name}  (${c.id})`).join('\n') +
      (apiError ? `\n\n(API listing unavailable: ${apiError})` : '');

    if (wanted) {
      const match = clusters.find(
        (c) => c.id === wanted || c.name.toLowerCase() === wanted.toLowerCase(),
      );
      if (match) return match;
      throw new Error(
        `Cluster "${wanted}" not found. Available clusters:\n${available()}`,
      );
    }
    if (clusters.length === 1) return clusters[0];
    if (clusters.length === 0) {
      throw new Error('No clusters found. Create one with `flui env create`.');
    }
    throw new Error(
      `Multiple clusters found. Specify one with --cluster:\n${available()}`,
    );
  }

  // Resolve the DB pod by label on the master and port-forward it on loopback.
  private buildRemoteCommand(
    namespace: string,
    selector: string,
    localPort: number,
    remotePort: number,
  ): string {
    const lines = [
      'set -e',
      `fuser -k -n tcp ${localPort} 2>/dev/null || true`,
      `POD=$(kubectl -n ${namespace} get pod -l ${selector} -o jsonpath='{.items[0].metadata.name}')`,
      'if [ -z "$POD" ]; then echo "no database pod found"; exit 1; fi',
      'trap "kill 0" INT TERM EXIT HUP',
      `kubectl -n ${namespace} port-forward --address 127.0.0.1 "pod/$POD" ${localPort}:${remotePort} &`,
      'wait',
    ];
    return `sh -c '${lines.join('\n')}'`;
  }

  private printConnection(
    info: DbConnectionInfo,
    password: string,
    localPort: number,
    profile: CliEngineProfile,
  ): void {
    const enc = encodeURIComponent(password);
    const url = `${profile.urlScheme}://${info.user}:${enc}@127.0.0.1:${localPort}/${info.database}`;
    const client = profile.clientHint(
      info.user,
      info.database,
      localPort,
      password,
    );
    console.log(chalk.green('\n✅ Tunnel up. Connect a client to:\n'));
    console.log(`   ${chalk.bold('Host:')}     127.0.0.1`);
    console.log(`   ${chalk.bold('Port:')}     ${localPort}`);
    console.log(`   ${chalk.bold('Database:')} ${info.database}`);
    console.log(`   ${chalk.bold('User:')}     ${info.user}`);
    console.log(
      `   ${chalk.bold('Password:')} ${chalk.yellow(password || '(unavailable)')}`,
    );
    console.log(chalk.cyan('\n📝 Connection string:'));
    console.log(`   ${chalk.dim(url)}`);
    console.log(chalk.cyan(`\n🧪 ${profile.label} client:`));
    console.log(`   ${chalk.dim(client)}`);
    console.log(chalk.dim('\n   CTRL-C to close the tunnel.\n'));
  }
}
