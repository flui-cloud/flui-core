import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';
import { resolveClusterRef } from '../../lib/resolve-cluster';
import { confirmByTypingPrompt } from '../../lib/prompts';

interface OrphanedClaim {
  name: string;
  namespace: string;
  requested: string | null;
  requestedBytes: number;
  sizeLabel: string;
  storageClass: string | null;
  phase: string | null;
  createdAt: string | null;
  lastKnownApplication?: { id: string; name: string; deletedAt: string | null };
  reason: string;
}

interface OrphanedClaims {
  clusterId: string;
  namespacesScanned: string[];
  claims: OrphanedClaim[];
  totalBytes: number;
  totalLabel: string;
  note?: string;
}

/**
 * The storage of applications that no longer exist.
 *
 * Uninstalling now takes the volume with it, but that repairs the future only:
 * every instance already running holds claims left by removals that happened
 * before it did. Nothing listed them, so nobody knew
 * they were there — this is the listing, and `--remove` is the way out.
 */
export default class ClusterVolumes extends Command {
  static readonly description =
    'List persistent volumes left behind by applications that no longer exist. ' +
    'A volume is only reported when no pod mounts it, no StatefulSet could have ' +
    'made it, and no existing application owns it. Removing one is permanent.';

  static readonly summary = 'Find (and remove) volumes with no application';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --output json',
    '<%= config.bin %> <%= command.id %> --remove user-a1b2c3/data-uptime-kuma-0',
  ];

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description:
        'Cluster name or ID (default: auto-detect when only one cluster exists)',
    }),
    remove: Flags.string({
      description:
        'Delete one abandoned volume, given as <namespace>/<name>. Permanent.',
    }),
    force: Flags.boolean({
      char: 'f',
      description: 'Skip the confirmation prompt of --remove',
      default: false,
    }),
    output: Flags.string({
      char: 'o',
      description: 'Output format',
      options: ['table', 'json'],
      default: 'table',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(ClusterVolumes);
    const cfg = new ConfigStorage();
    const apiKey = cfg.getApiKey();
    if (!apiKey) {
      console.log(
        chalk.red('\n  Not logged in. Run `flui auth login` first.\n'),
      );
      this.exit(1);
    }
    const api = new ApiClient({ baseUrl: cfg.getApiUrlOrThrow(), apiKey });

    const spinner = ora('Looking for abandoned volumes…').start();
    let cluster: { id: string; name: string };
    let report: OrphanedClaims;
    try {
      cluster = await resolveClusterRef(flags.cluster);
      report = await api.get<OrphanedClaims>(
        `/infrastructure/clusters/${cluster.id}/storage/orphaned-claims`,
      );
    } catch (error: any) {
      spinner.fail('Lookup failed');
      console.log(
        chalk.red(
          `\n  Error: ${error.response?.data?.message ?? error.message}\n`,
        ),
      );
      this.exit(1);
    }
    spinner.stop();

    if (flags.output === 'json') {
      console.log(JSON.stringify(report, null, 2));
      if (!flags.remove) return;
    }

    if (flags.remove) {
      await this.removeOne(api, cluster, report, flags.remove, flags.force);
      return;
    }

    this.print(cluster, report, flags.output === 'json');
  }

  private print(
    cluster: { name: string },
    report: OrphanedClaims,
    quiet: boolean,
  ): void {
    if (quiet) return;

    if (report.note) {
      console.log(chalk.yellow(`\n  ${report.note}\n`));
      return;
    }
    if (report.claims.length === 0) {
      console.log(
        chalk.green(
          `\n  No abandoned volumes on "${cluster.name}" ` +
            `(${report.namespacesScanned.length} namespace(s) scanned).\n`,
        ),
      );
      return;
    }

    console.log(
      chalk.yellow(
        `\n  ${report.claims.length} abandoned volume(s) on "${cluster.name}", ` +
          `${report.totalLabel} in total:\n`,
      ),
    );
    for (const claim of report.claims) {
      console.log(
        `    ${chalk.bold(claim.sizeLabel.padEnd(9))} ${claim.namespace}/${claim.name}`,
      );
      console.log(chalk.dim(`              ${claim.reason}`));
    }
    console.log('');
    console.log(
      chalk.dim(
        '  Remove one with: flui cluster volumes --remove <namespace>/<name>\n',
      ),
    );
  }

  private async removeOne(
    api: ApiClient,
    cluster: { id: string; name: string },
    report: OrphanedClaims,
    ref: string,
    force: boolean,
  ): Promise<void> {
    const slash = ref.indexOf('/');
    if (slash <= 0 || slash === ref.length - 1) {
      console.log(
        chalk.red(`\n  --remove expects <namespace>/<name>, got "${ref}"\n`),
      );
      this.exit(1);
    }
    const namespace = ref.slice(0, slash);
    const name = ref.slice(slash + 1);

    // Only what the listing itself reported. Deleting a claim the scan did not
    // call abandoned is exactly the mistake this command exists to avoid; the
    // API refuses it too, and refusing twice costs nothing.
    const claim = report.claims.find(
      (c) => c.namespace === namespace && c.name === name,
    );
    if (!claim) {
      console.log(
        chalk.red(
          `\n  "${ref}" is not in the abandoned list for "${cluster.name}".\n`,
        ),
      );
      console.log(
        chalk.dim(
          '  Run the command without --remove to see what is actually abandoned.\n',
        ),
      );
      this.exit(1);
    }

    console.log(chalk.red('\n  DELETE volume\n'));
    console.log(`  ${chalk.bold('Claim:')}  ${claim.namespace}/${claim.name}`);
    console.log(`  ${chalk.bold('Size:')}   ${claim.sizeLabel}`);
    console.log(`  ${chalk.bold('Why:')}    ${claim.reason}`);
    console.log(
      chalk.red('\n  The data on this volume is deleted permanently.\n'),
    );

    if (!force) {
      console.log(
        chalk.yellow(
          `  To confirm, type the claim name exactly: ${chalk.bold(claim.name)}`,
        ),
      );
      const confirmed = await confirmByTypingPrompt(
        chalk.yellow('  Claim name'),
        claim.name,
      );
      if (!confirmed) {
        console.log(chalk.green('\n  Cancelled (name did not match)\n'));
        return;
      }
    }

    const spinner = ora('Removing…').start();
    try {
      const result = await api.delete<{ freed: string }>(
        `/infrastructure/clusters/${cluster.id}/storage/orphaned-claims/` +
          `${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`,
      );
      spinner.succeed(`Removed — ${result.freed} freed`);
      console.log('');
    } catch (error: any) {
      spinner.fail('Removal refused');
      console.log(
        chalk.red(`\n  ${error.response?.data?.message ?? error.message}\n`),
      );
      this.exit(1);
    }
  }
}
