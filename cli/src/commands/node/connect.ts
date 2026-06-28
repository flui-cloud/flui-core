import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { getNestApp, closeNestApp } from '../../lib/nest-app';
import { CliControlClusterService } from '../../services/cli-control-cluster.service';
import { CliClusterCreatorService } from '../../services/cli-cluster-creator.service';
import { CliSshService } from '../../services/cli-ssh.service';
import { CloudProvider } from 'src/modules/providers/enums/cloud-provider.enum';
import { ClusterStatus } from 'src/modules/infrastructure/clusters/entities/cluster.entity';
import { printContextBanner } from '../../lib/context-banner';

export default class NodeConnect extends Command {
  static readonly description =
    'BYOS: join an existing Linux host to the cluster as a worker node (over SSH, no provisioning).';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> --host 203.0.113.10',
    '<%= config.bin %> <%= command.id %> --host 10.0.0.12 --master-ip 10.0.0.11 --node-network 10.0.0.0/24',
    '<%= config.bin %> <%= command.id %> --host localhost --port 2223 --ssh-key ~/.flui/byos-local/operator_key --master-ip 10.89.0.2',
  ];

  static readonly flags = {
    host: Flags.string({
      description: 'IP or DNS of the existing host to join as a worker',
      required: true,
    }),
    port: Flags.integer({ description: 'SSH port of --host', default: 22 }),
    user: Flags.string({ description: 'SSH user for --host', default: 'root' }),
    'ssh-key': Flags.string({
      description:
        'Path to the SSH private key that already authenticates to --host (default: ~/.ssh/id_rsa)',
    }),
    'master-ip': Flags.string({
      description:
        'Address the new node uses to reach the master k3s API (https://<addr>:6443). Defaults to the cluster master IP.',
    }),
    'node-network': Flags.string({
      description:
        'CIDR of the private network the nodes share (host firewall must allow it for node-to-node k3s traffic). Defaults to the /24 of the detected private IP.',
    }),
    'skip-precheck': Flags.boolean({
      description: 'Skip the host readiness precheck',
      default: false,
    }),
    'best-effort': Flags.boolean({
      description: 'Continue even if the precheck reports problems',
      default: false,
    }),
  };

  private resolveKeyPath(flag?: string): string {
    const raw = flag || path.join(os.homedir(), '.ssh', 'id_rsa');
    return raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
  }

  private async precheck(
    sshService: CliSshService,
    conn: { host: string; port: number; user: string; keyPath: string },
    bestEffort: boolean,
  ): Promise<void> {
    const probe = await sshService.sshExecWithKey({
      ...conn,
      command:
        '. /etc/os-release 2>/dev/null || true; ' +
        'printf "os=%s\\n" "${PRETTY_NAME:-unknown}"; ' +
        'printf "arch=%s\\n" "$(uname -m)"; ' +
        'printf "memkb=%s\\n" "$(grep MemTotal /proc/meminfo | tr -dc 0-9)"; ' +
        'printf "cpu=%s\\n" "$(nproc)"; ' +
        'printf "k3s=%s\\n" "$(command -v k3s || echo none)"',
    });
    const get = (k: string): string =>
      (new RegExp(`${k}=(.*)`).exec(probe)?.[1] ?? '').trim();
    const memMb = Math.floor(
      (Number.parseInt(get('memkb') || '0', 10) || 0) / 1024,
    );
    const arch = get('arch');
    const k3s = get('k3s');
    console.log(
      chalk.dim(
        `   Host: ${get('os')} · ${arch} · ${memMb}MB RAM · ${get('cpu')} vCPU`,
      ),
    );

    const problems: string[] = [];
    if (!/x86_64|aarch64|arm64/.test(arch))
      problems.push(`unsupported architecture: ${arch}`);
    if (memMb > 0 && memMb < 1800)
      problems.push(`low memory: ${memMb}MB (recommend ≥2GB)`);
    if (k3s !== 'none') problems.push(`k3s already installed at ${k3s}`);

    if (problems.length > 0) {
      const bullets = problems.map((p) => `   • ${p}`).join('\n');
      console.log(chalk.yellow(`\n⚠ Precheck warnings:\n${bullets}\n`));
      if (!bestEffort) {
        this.error(
          'Precheck failed. Re-run with --best-effort to proceed anyway, or --skip-precheck to skip it.',
          { exit: 1 },
        );
      }
    }
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(NodeConnect);
    const host = flags.host;
    const port = flags.port ?? 22;
    const user = flags.user ?? 'root';
    const keyPath = this.resolveKeyPath(flags['ssh-key']);

    if (!fs.existsSync(keyPath)) {
      this.error(`SSH key not found: ${keyPath}. Pass --ssh-key <path>.`, {
        exit: 1,
      });
    }

    printContextBanner({ cluster: { provider: 'byos', region: host } });

    let spinner = ora('Initializing...').start();
    let app: any;
    try {
      app = await getNestApp();
      const controlService = app.get(CliControlClusterService);
      const creator = app.get(CliClusterCreatorService);
      const sshService = app.get(CliSshService);
      spinner.succeed('Initialized');

      const cluster = await controlService.getControlCluster();
      if (!cluster || cluster.status === ClusterStatus.DELETED) {
        console.log(
          chalk.yellow(
            '\n⚠️  No control cluster found. Create one first with `flui env create --host …`.\n',
          ),
        );
        return;
      }
      if (cluster.provider !== CloudProvider.BYOS) {
        console.log(
          chalk.yellow(
            `\n⚠️  This cluster is provider '${cluster.provider}', not BYOS.\n` +
              '   Use `flui node add` to provision and join managed worker nodes.\n',
          ),
        );
        return;
      }

      const masterIp = flags['master-ip'] || cluster.masterIpAddress;
      if (!masterIp) {
        this.error(
          'Could not determine the master address. Pass --master-ip <addr> (the address the new node uses to reach the master k3s API).',
          { exit: 1 },
        );
      }
      const masterLoopback = /^(127\.|localhost$|::1$)/.test(masterIp);

      console.log(
        chalk.cyan('\n🔗 Joining a worker node to your cluster (BYOS)\n'),
      );
      console.log(chalk.dim('   Before you start, make sure:'));
      console.log(
        chalk.dim(
          `   1. The host ${user}@${host}:${port} is reachable over SSH with the key below`,
        ),
      );
      const sshCmd = chalk.cyan(`ssh -p ${port} -i ${keyPath} ${user}@${host}`);
      console.log(chalk.dim(`      ${sshCmd}`));
      const masterEndpoint = chalk.bold(`${masterIp}:6443`);
      console.log(
        chalk.dim(
          `   2. The host can reach the master k3s API at ${masterEndpoint} on the shared private network`,
        ),
      );
      console.log(
        chalk.dim(
          '   3. k3s is NOT already installed on the host (a clean Linux box)\n',
        ),
      );

      if (masterLoopback && !flags['master-ip']) {
        console.log(
          chalk.yellow(
            `   ⚠ The cluster master IP is ${masterIp} (loopback) — a worker on another host can't reach it.\n` +
              "     Pass --master-ip <address-reachable-from-the-worker> (e.g. the master's private/LAN IP).\n",
          ),
        );
      }

      if (!flags['skip-precheck']) {
        spinner = ora(`Prechecking ${user}@${host}:${port}...`).start();
        try {
          spinner.stop();
          await this.precheck(
            sshService,
            { host, port, user, keyPath },
            !!flags['best-effort'],
          );
        } catch (e: any) {
          console.log(chalk.red(`\n❌ Precheck failed: ${e.message}\n`));
          this.exit(1);
        }
      }

      console.log(chalk.dim('─'.repeat(80)));
      const result = await creator.joinWorkerByos({
        cluster,
        host,
        port,
        user,
        keyPath,
        masterIp,
        nodeNetwork: flags['node-network'],
        onLog: (m: string) => console.log(m),
      });
      console.log(chalk.dim('─'.repeat(80)));

      console.log(chalk.green('\n✅ Worker node joined!\n'));
      console.log(`   ${chalk.bold('Node:')}      ${result.serverName}`);
      if (result.privateIp)
        console.log(`   ${chalk.bold('Private IP:')} ${result.privateIp}`);
      console.log(chalk.dim('\n   Verify with:'));
      console.log(chalk.cyan('   flui node list'));
      console.log(
        chalk.cyan('   flui ssh master') + chalk.dim('  → kubectl get nodes\n'),
      );
    } catch (error: any) {
      console.log(chalk.red(`\n❌ Failed to join worker: ${error.message}\n`));
      this.exit(1);
    } finally {
      await closeNestApp();
    }
  }
}
