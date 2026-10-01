import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { getNestApp, closeNestApp } from '../../lib/nest-app';
import {
  openControlPlane,
  printControlPlaneError,
} from '../../lib/control-plane-api';
import { printContextBanner } from '../../lib/context-banner';
import { resolveClusterRef } from '../../lib/resolve-cluster';

interface FileProof {
  name: string;
  proven: boolean;
  ref?: string;
  reason?: string;
}

interface ValuesPlan {
  clusterId: string;
  clusterType: string;
  planId: string;
  recorded: 'installer' | 'reconstructed' | null;
  bootstrapRef: string | null;
  files: FileProof[];
  values: Record<string, string>;
  unproven: Record<string, string>;
  willWrite: boolean;
  reason?: string;
  written?: boolean;
}

/**
 * An installation built before the installer kept a record of its values
 * cannot have its templated manifests brought forward: an update renders a
 * file only with values proven against the master. This proves them, file by
 * file, and records what it can.
 */
export default class EnvInstallValues extends Command {
  static readonly description =
    'Rebuild the record of the values this installation was built with, so an update can bring its templated manifests forward. Each value is kept only when rendering a file with it reproduces the copy on the master exactly. Shows what it proved and writes nothing unless asked.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --cluster my-workload',
    '<%= config.bin %> <%= command.id %> --apply --plan 3f9c2a1',
  ];

  static readonly flags = {
    cluster: Flags.string({
      description: 'Cluster name or id. Defaults to the control cluster.',
    }),
    apply: Flags.boolean({
      default: false,
      description: 'Record the proven values. Needs --plan from a dry run.',
    }),
    plan: Flags.string({ description: 'The plan id a dry run printed.' }),
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(EnvInstallValues);
    if (!flags.json) printContextBanner();

    if (flags.apply && !flags.plan) {
      this.log('');
      this.log(
        `   ${chalk.yellow('--apply needs --plan <id>')} ${chalk.dim('from a dry run.')}`,
      );
      this.log(chalk.dim('   Run it without --apply first.\n'));
      this.exit(1);
      return;
    }

    const progress = flags.apply
      ? 'Recording...'
      : 'Proving values against the master...';
    const spinner = flags.json ? null : ora(progress).start();
    try {
      const clusterId = flags.cluster
        ? (await resolveClusterRef(flags.cluster)).id
        : undefined;
      const { api } = await openControlPlane(await getNestApp());
      const body = {
        ...(clusterId ? { clusterId } : {}),
        ...(flags.apply ? { planId: flags.plan } : {}),
      };
      // It runs short jobs on the master and waits for them.
      const result = await api.post<ValuesPlan>(
        `/platform/updates/manifests/values/${flags.apply ? 'apply' : 'plan'}`,
        body,
        { timeoutMs: 300_000 },
      );
      spinner?.stop();

      if (flags.json) {
        this.log(JSON.stringify(result, null, 2));
        return;
      }
      this.render(result, flags.apply, flags.cluster);
    } catch (error) {
      spinner?.fail(
        flags.apply ? 'Could not record' : 'Could not read the master',
      );
      printControlPlaneError(error);
      this.exit(1);
    } finally {
      await closeNestApp();
    }
  }

  private render(plan: ValuesPlan, applied: boolean, cluster?: string): void {
    this.renderOrigin(plan);
    this.renderFiles(plan);
    this.renderValues(plan);
    this.log('');
    if (applied) {
      this.log(
        plan.written
          ? `   ${chalk.green('Recorded.')} ${chalk.dim('An update can now render the files these values prove.')}\n`
          : chalk.dim(`   Nothing recorded. ${plan.reason ?? ''}\n`),
      );
      return;
    }
    if (!plan.willWrite) {
      this.log(chalk.dim(`   Nothing to record. ${plan.reason ?? ''}\n`));
      return;
    }
    const target = cluster ? ` --cluster ${cluster}` : '';
    this.log(`   ${chalk.dim('plan')} ${chalk.bold(plan.planId)}`);
    this.log(
      chalk.dim(
        `   To record: flui env install-values${target} --apply --plan ${plan.planId}\n`,
      ),
    );
  }

  private renderOrigin(plan: ValuesPlan): void {
    this.log('');
    if (plan.recorded) {
      const by =
        plan.recorded === 'installer'
          ? 'the installer'
          : 'an earlier reconstruction';
      const note = `by ${by}; nothing is rewritten.`;
      this.log(`   ${chalk.green('Already recorded')} ${chalk.dim(note)}`);
    }
    if (plan.bootstrapRef) {
      this.log(
        `   ${chalk.dim('built from')} ${chalk.bold(plan.bootstrapRef)}`,
      );
    }
  }

  private renderFiles(plan: ValuesPlan): void {
    const proven = plan.files.filter((f) => f.proven);
    const notProven = plan.files.filter((f) => !f.proven);
    const provenCount = `${proven.length} file(s) proven`;
    const notProvenCount = `, ${notProven.length} not`;
    this.log('');
    this.log(`   ${chalk.bold(provenCount)}${chalk.dim(notProvenCount)}`);
    for (const f of notProven) {
      this.log(
        `     ${chalk.dim(f.name.padEnd(28))} ${chalk.dim(f.reason ?? '')}`,
      );
    }
  }

  private renderValues(plan: ValuesPlan): void {
    const names = Object.keys(plan.values).sort((a, b) => a.localeCompare(b));
    if (names.length > 0) {
      this.log('');
      this.log(chalk.dim('   values proven'));
      for (const name of names) {
        this.log(`     ${name.padEnd(28)} ${plan.values[name]}`);
      }
    }
    const missing = Object.entries(plan.unproven);
    if (missing.length > 0) {
      this.log('');
      this.log(chalk.dim('   not proven'));
      for (const [name, why] of missing) {
        this.log(`     ${chalk.dim(name.padEnd(28))} ${chalk.dim(why)}`);
      }
    }
  }
}
