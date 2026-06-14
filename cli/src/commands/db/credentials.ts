import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { getNestApp, closeNestApp } from '../../lib/nest-app';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';
import { CliAppService } from '../../lib/services/cli-app.service';
import { resolveCluster } from '../../lib/resolve-cluster';
import { CliSshService } from '../../services/cli-ssh.service';
import { readDbPassword } from '../../lib/db-secret';
import { engineProfile } from '../../lib/db-engine';

interface DbConnectionInfo {
  engine: string;
  database: string;
  user: string;
  namespace: string;
  podLabelSelector: string;
  clusterId: string;
  remotePort: number;
}

export default class DbCredentials extends Command {
  static readonly description =
    'Show how to connect to a Flui database: the in-cluster address (for another app\n' +
    'running on Flui) and its credentials. The password is read from the in-cluster\n' +
    'Secret over SSH and is hidden unless you pass --show. To connect a native client\n' +
    'from your machine, use `flui db tunnel` instead.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> postgresql-051f58',
    '<%= config.bin %> <%= command.id %> postgresql-051f58 --show',
    '<%= config.bin %> <%= command.id %> postgresql-051f58 --show --hide-after 30',
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
    show: Flags.boolean({
      description: 'Print the password in plaintext (hidden by default)',
      default: false,
    }),
    'hide-after': Flags.integer({
      description:
        'Opt-in optical wipe: hold the terminal for N seconds with a countdown, then erase the password from view. Off by default (0) so the command returns immediately. Only with --show on a TTY.',
      default: 0,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(DbCredentials);
    const spinner = ora('Resolving database...').start();

    try {
      const cluster = await resolveCluster(flags.cluster);
      const appService = await CliAppService.create(cluster.id);
      const app = await appService.getAppByName(args.app);

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

      const dbCluster =
        info.clusterId === cluster.id
          ? cluster
          : await resolveCluster(info.clusterId);
      const masterIp = dbCluster.entity.masterIpAddress;
      if (!masterIp) {
        spinner.fail(`Master IP not available for cluster ${dbCluster.name}`);
        this.exit(1);
        return;
      }

      const profile = engineProfile(info.engine);
      const sshApp = await getNestApp();
      const sshService = sshApp.get(CliSshService);
      const password = await readDbPassword(
        sshService,
        masterIp,
        info.namespace,
        app.slug,
        profile.secretPasswordKeys,
      );
      spinner.succeed(`${app.slug} (${profile.label}, ${info.namespace})`);

      const host = `${app.slug}-svc.${info.namespace}.svc.cluster.local`;
      const shown = flags.show ? password : '(hidden — pass --show to reveal)';
      const enc = flags.show ? encodeURIComponent(password) : '<password>';
      const url = `${profile.urlScheme}://${info.user}:${enc}@${host}:${info.remotePort}/${info.database}`;

      const lines = [
        chalk.cyan('🔌 From another app running on Flui (same cluster):'),
        '',
        `   ${chalk.bold('Host:')}     ${host}`,
        `   ${chalk.bold('Port:')}     ${info.remotePort}`,
        `   ${chalk.bold('Database:')} ${info.database}`,
        `   ${chalk.bold('User:')}     ${info.user}`,
        `   ${chalk.bold('Password:')} ${chalk.yellow(shown)}`,
        '',
        chalk.cyan('📝 DATABASE_URL:'),
        `   ${chalk.dim(url)}`,
        '',
        chalk.dim(
          `   For a native client on your machine: flui db tunnel ${app.slug}`,
        ),
      ];

      const hideAfter = flags['hide-after'];
      const canHide = flags.show && !!process.stdout.isTTY && hideAfter > 0;

      if (!canHide) {
        console.log('\n' + lines.join('\n') + '\n');
        return;
      }

      // Print, then wipe from the screen after the timeout. Save/restore the cursor
      // (DECSC/DECRC) so the wipe is correct even if long lines wrap.
      console.log();
      process.stdout.write('\x1b7'); // save cursor at top of the block
      console.log(lines.join('\n'));
      await this.hideAfterCountdown(hideAfter);
      process.stdout.write('\x1b8\x1b[0J'); // restore to top + clear to end of screen
      console.log(
        chalk.dim(
          '🔒 Credentials hidden. Re-run with --show to display again.',
        ),
      );
    } catch (error) {
      spinner.fail('Failed to read credentials');
      console.error(chalk.red(`\n❌ ${(error as Error).message}\n`));
      this.exit(1);
    } finally {
      await closeNestApp();
    }
  }

  // Hold for `seconds`, updating an in-place countdown footer; Ctrl-C ends it early.
  private async hideAfterCountdown(seconds: number): Promise<void> {
    const footer = (n: number) =>
      chalk.dim(`   ⏳ Hiding in ${n}s — Ctrl-C to dismiss now…`);
    process.stdout.write(footer(seconds));
    let remaining = seconds;
    let dismissed = false;
    const onSig = () => {
      dismissed = true;
    };
    process.on('SIGINT', onSig);
    try {
      while (remaining > 0 && !dismissed) {
        await new Promise((r) => setTimeout(r, 1000));
        remaining -= 1;
        // \r to col 0, \x1b[K clears the line, then rewrite.
        process.stdout.write('\r\x1b[K' + footer(Math.max(remaining, 0)));
      }
    } finally {
      process.off('SIGINT', onSig);
    }
  }
}
