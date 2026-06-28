import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { getNestApp, closeNestApp } from '../../lib/nest-app';
import { CliControlClusterService } from '../../services/cli-control-cluster.service';
import { CliSshService } from '../../services/cli-ssh.service';
import { ClusterStatus } from 'src/modules/infrastructure/clusters/entities/cluster.entity';
import {
  resolveClusterSshTarget,
  SshTarget,
} from '../../lib/cluster-ssh-target';

interface ForwardSpec {
  name: string;
  localPort: number;
  remotePort: number;
  service?: string;
  namespace?: string;
  needsKubectl: boolean;
}

const FORWARDS: Record<string, ForwardSpec> = {
  postgres: {
    name: 'postgres',
    localPort: 5432,
    remotePort: 5432,
    service: 'svc/postgres',
    namespace: 'flui-system',
    needsKubectl: true,
  },
  redis: {
    name: 'redis',
    localPort: 6379,
    remotePort: 6379,
    service: 'svc/redis',
    namespace: 'flui-system',
    needsKubectl: true,
  },
  'kube-api': {
    name: 'kube-api',
    localPort: 6443,
    remotePort: 6443,
    needsKubectl: false,
  },
  grafana: {
    name: 'grafana',
    localPort: 3001,
    remotePort: 3000,
    service: 'svc/grafana',
    namespace: 'flui-control',
    needsKubectl: true,
  },
  vmsingle: {
    name: 'vmsingle',
    localPort: 9090,
    remotePort: 8428,
    service: 'svc/vmsingle',
    namespace: 'flui-control',
    needsKubectl: true,
  },
  loki: {
    name: 'loki',
    localPort: 3100,
    remotePort: 3100,
    service: 'svc/loki',
    namespace: 'flui-control',
    needsKubectl: true,
  },
};

export default class DevTunnel extends Command {
  static readonly description =
    'Open SSH tunnels from localhost to the control cluster services.\n' +
    'On the remote side runs kubectl port-forward against the in-cluster Services,\n' +
    'so no NodePort or kube-API exposure is required. Stay in foreground; CTRL-C to close.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --ports postgres,redis',
    '<%= config.bin %> <%= command.id %> --ports postgres,redis,kube-api,grafana',
    '<%= config.bin %> <%= command.id %> --no-retry',
  ];

  static readonly flags = {
    ports: Flags.string({
      description:
        'Comma-separated list of forwards to open. ' +
        `Available: ${Object.keys(FORWARDS).join(', ')}`,
      default: 'postgres,redis,kube-api,vmsingle,loki',
    }),
    retry: Flags.boolean({
      description:
        'Reconnect automatically if the SSH session drops. Disable with --no-retry.',
      default: true,
      allowNo: true,
    }),
    'kill-local': Flags.boolean({
      description:
        'Kill any local process bound to the requested ports before opening the tunnel. Disable with --no-kill-local.',
      default: true,
      allowNo: true,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(DevTunnel);
    const spinner = ora('Resolving cluster...').start();

    let masterIp: string | undefined;
    let sshT: SshTarget | undefined;
    try {
      const app = await getNestApp();
      const controlService = app.get(CliControlClusterService);
      const cluster = await controlService.getControlCluster();

      if (!cluster) {
        spinner.fail('No control cluster found');
        console.log(chalk.yellow('\n⚠️  Run `flui env create` first.\n'));
        return;
      }
      if (cluster.status !== ClusterStatus.READY) {
        spinner.fail(`Cluster not ready (status: ${cluster.status})`);
        return;
      }
      masterIp = cluster.masterIpAddress ?? undefined;
      if (!masterIp) {
        spinner.fail('Master IP address not available');
        return;
      }
      sshT = resolveClusterSshTarget(cluster, masterIp);
      spinner.succeed(
        `Cluster ${cluster.name} → master ${sshT.host}:${sshT.port}`,
      );
    } catch (error) {
      spinner.fail('Error resolving cluster');
      console.error(chalk.red(`\n❌ ${(error as Error).message}\n`));
      this.exit(1);
      return;
    }

    const requested = flags.ports
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const unknown = requested.filter((p) => !FORWARDS[p]);
    if (unknown.length > 0) {
      console.error(chalk.red(`\n❌ Unknown port(s): ${unknown.join(', ')}\n`));
      console.error(
        chalk.dim(`Available: ${Object.keys(FORWARDS).join(', ')}\n`),
      );
      this.exit(1);
      return;
    }
    const specs = requested.map((p) => FORWARDS[p]);

    this.printForwardTable(specs);

    if (flags['kill-local']) {
      await this.freeLocalPorts(specs.map((s) => s.localPort));
    }

    const remoteCommand = this.buildRemoteCommand(specs);
    const sshForwards = specs.map((s) => ({
      localPort: s.localPort,
      remotePort: s.localPort, // remote side listens on same port via kubectl/loopback
    }));

    const app = await getNestApp();
    const sshService = app.get(CliSshService);

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
              `\n🔌 Opening SSH tunnel to ${sshT.host}:${sshT.port}. Press CTRL-C to close.\n`,
            ),
          );
        }
        const result = await sshService.sshForward({
          host: sshT.host,
          port: sshT.port,
          username: sshT.user,
          forwards: sshForwards,
          remoteCommand,
          expectedForwardLines: specs.filter((s) => s.needsKubectl).length,
          onReady: () => {
            console.log(chalk.green('\n✅ Tunnel up. Localhost endpoints:\n'));
            for (const s of specs) {
              console.log(`   ${s.name.padEnd(11)} → 127.0.0.1:${s.localPort}`);
            }
            console.log();
          },
        });
        if (userExit || !flags.retry) break;
        console.log(
          chalk.yellow(
            `SSH session ended (status=${result.status}, signal=${result.signal}).`,
          ),
        );
        // small backoff
        await new Promise((r) => setTimeout(r, 2000));
      }
    } finally {
      process.off('SIGINT', onSigint);
      await closeNestApp();
    }
  }

  // A local container runtime (gvproxy/vpnkit/vfkit) holds the VM's published
  // ports — killing it drops the whole VM network, so we never SIGKILL it.
  private isRuntimeInfra(command: string): boolean {
    return /gvproxy|vpnkit|vfkit|qemu|krunkit|com\.docker|dockerd|Virtualization\.framework/i.test(
      command,
    );
  }

  private async processCommand(pid: number): Promise<string> {
    try {
      const { stdout } = await execFileAsync('ps', [
        '-p',
        String(pid),
        '-o',
        'command=',
      ]);
      return stdout.trim();
    } catch {
      return '';
    }
  }

  private async freeLocalPorts(ports: number[]): Promise<void> {
    for (const port of ports) {
      const pids = await this.findListeningPids(port);
      if (pids.length === 0) continue;
      const ownPid = process.pid;
      const targets: number[] = [];
      for (const pid of pids) {
        if (pid === ownPid) continue;
        const cmd = await this.processCommand(pid);
        if (this.isRuntimeInfra(cmd)) {
          console.log(
            chalk.yellow(
              `⚠️  Port ${port} is served by the local container runtime (pid ${pid}) — ` +
                `leaving it alone (killing it would drop the VM network). ` +
                `It's already reachable; drop it from --ports if SSH warns about the bind.`,
            ),
          );
          continue;
        }
        targets.push(pid);
      }
      if (targets.length === 0) continue;
      console.log(
        chalk.yellow(
          `⚠️  Port ${port} in use by pid(s) ${targets.join(', ')} — killing...`,
        ),
      );
      for (const pid of targets) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          /* already gone */
        }
      }
      await new Promise((r) => setTimeout(r, 400));
      const stillThere = (await this.findListeningPids(port)).filter(
        (p) => p !== ownPid && targets.includes(p),
      );
      for (const pid of stillThere) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
  }

  private async findListeningPids(port: number): Promise<number[]> {
    try {
      const { stdout } = await execFileAsync('lsof', [
        '-ti',
        `tcp:${port}`,
        '-sTCP:LISTEN',
      ]);
      return stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => Number.parseInt(s, 10))
        .filter((n) => Number.isFinite(n));
    } catch {
      return [];
    }
  }

  private printForwardTable(specs: ForwardSpec[]): void {
    console.log(chalk.cyan('\n📡 Forwards to open:\n'));
    for (const s of specs) {
      const target = s.service
        ? `${s.namespace}/${s.service}:${s.remotePort}`
        : `master:127.0.0.1:${s.remotePort}`;
      console.log(
        `   ${s.name.padEnd(11)} 127.0.0.1:${s.localPort}  →  ${target}`,
      );
    }
  }

  private buildRemoteCommand(specs: ForwardSpec[]): string | undefined {
    const kubectlSpecs = specs.filter((s) => s.needsKubectl);
    if (kubectlSpecs.length === 0) {
      // Nothing to run remotely; SSH -N is enough. The kube-API is reached via
      // the local-forward to 127.0.0.1:6443 on the master (kube-API binds there).
      return undefined;
    }

    // Use newlines as separators: `&` terminates a command on its own, so
    // joining with `; ` would emit invalid `&;` sequences. Trap HUP too so
    // we clean up child kubectl processes when SSH disconnects.
    const portsToFree = kubectlSpecs.map((s) => s.localPort).join(' ');
    const lines = [
      // Pre-cleanup: free the loopback ports we want to bind. fuser -k is
      // port-targeted (won't match our own sh wrapper by accident); pkill
      // is a fallback if fuser is not installed.
      `for p in ${portsToFree}; do fuser -k -n tcp $p 2>/dev/null || true; done`,
      'pkill -f "^kubectl .*port-forward" 2>/dev/null || true',
      'sleep 1',
      'trap "kill 0" INT TERM EXIT HUP',
    ];
    for (const s of kubectlSpecs) {
      lines.push(
        `kubectl -n ${s.namespace} port-forward --address 127.0.0.1 ${s.service} ${s.localPort}:${s.remotePort} &`,
      );
    }
    lines.push('wait');
    return `sh -c '${lines.join('\n')}'`;
  }
}
