import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import * as path from 'node:path';
import * as os from 'node:os';
import { getNestApp, closeNestApp } from '../../lib/nest-app';
import { CliControlClusterService } from '../../services/cli-control-cluster.service';
import { CliSshService } from '../../services/cli-ssh.service';
import { printContextBanner } from '../../lib/context-banner';
import { resolveClusterSshTarget } from '../../lib/cluster-ssh-target';
import { SealedCa } from '../../lib/vault/sealed-ca';
import { openProfileKey } from '../../lib/vault/open-profile-key';

export default class EnvRepairSshCa extends Command {
  static readonly description =
    'Backfill the SSH CA private key into the cluster flui-secrets Secret. Used to repair clusters that were provisioned before the CA seeding flow was complete — symptom is the Dashboard SSH terminal failing with "CA private key not available". Opens the CA private key of the active profile from the vault and patches the in-cluster Secret over SSH+cert.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --no-restart',
  ];

  static readonly flags = {
    'no-restart': Flags.boolean({
      description:
        'Skip the flui-api rolling restart after patching the Secret',
    }),
    profile: Flags.string({
      description:
        'Active profile name (default: $FLUI_PROFILE or contents of ~/.flui/context, fallback "default")',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(EnvRepairSshCa);
    printContextBanner();

    const profile =
      flags.profile ?? process.env.FLUI_PROFILE ?? this.readActiveProfile();
    const spinner = ora('Opening the SSH CA from the vault...').start();
    let caPrivateKey: string;
    try {
      await openProfileKey(profile);
      caPrivateKey = new SealedCa(profile).privateKey().trimEnd() + '\n';
      if (!caPrivateKey.includes('PRIVATE KEY')) {
        spinner.fail('The SSH CA does not look like an OpenSSH key');
        this.exit(1);
        return;
      }
      spinner.succeed(`SSH CA of profile "${profile}" opened`);
    } catch (err: any) {
      spinner.fail(`Could not open the SSH CA: ${err.message}`);
      this.exit(1);
      return;
    }

    const app = await getNestApp();
    try {
      const obs = app.get(CliControlClusterService);
      const ssh = app.get(CliSshService);
      const cluster = await obs.getControlCluster();
      if (!cluster?.masterIpAddress) {
        this.log(chalk.red('  No control cluster found in this profile.'));
        this.exit(1);
        return;
      }

      const sshT = resolveClusterSshTarget(cluster, cluster.masterIpAddress);
      const patchSpinner = ora(
        `Patching flui-secrets on ${cluster.masterIpAddress}...`,
      ).start();
      const base64 = Buffer.from(caPrivateKey).toString('base64');
      const patchCmd =
        `kubectl -n flui-system patch secret flui-secrets ` +
        `--type='json' -p='[{"op":"replace","path":"/data/SSH_CA_PRIVATE_KEY","value":"${base64}"}]'`;
      try {
        await ssh.sshExec(sshT.host, patchCmd, sshT.user, sshT.port);
        patchSpinner.succeed('Secret SSH_CA_PRIVATE_KEY patched');
      } catch (err: any) {
        patchSpinner.fail(`Patch failed: ${err.message}`);
        this.exit(1);
        return;
      }

      if (!flags['no-restart']) {
        const restartSpinner = ora('Restarting flui-api...').start();
        try {
          await ssh.sshExec(
            sshT.host,
            'kubectl -n flui-system rollout restart deployment/flui-api',
            sshT.user,
            sshT.port,
          );
          restartSpinner.succeed('flui-api rolling restart triggered');
        } catch (err: any) {
          restartSpinner.warn(
            `Restart failed (Secret was patched OK): ${err.message}`,
          );
        }
      }

      this.log('');
      this.log(
        chalk.green(
          '  ✅ CA repair complete. Dashboard terminal should now work.',
        ),
      );
      this.log(
        chalk.dim('     Hard-refresh the dashboard if it was already open.\n'),
      );
    } finally {
      await closeNestApp();
    }
  }

  private readActiveProfile(): string {
    try {
      const contextFile = path.join(os.homedir(), '.flui', 'context');
      const fsSync = require('node:fs') as typeof import('node:fs');
      return fsSync.readFileSync(contextFile, 'utf-8').trim() || 'default';
    } catch {
      return 'default';
    }
  }
}
