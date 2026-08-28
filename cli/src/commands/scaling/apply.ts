import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import * as fs from 'node:fs';
import type { ScalingGroupResponseDto } from 'src/modules/infrastructure/scaling/dto/scaling-response.dto';
import { resolveClusterRef } from '../../lib/resolve-cluster';
import { ScalingClient, scalingErrorLines } from '../../lib/scaling-client';
import {
  ScalingDocumentError,
  parseScalingGroupFile,
  type ScalingGroupDocument,
} from '../../lib/scaling-file';
import {
  describeCapability,
  describeSettle,
  describeStrategy,
  formatBounds,
} from '../../lib/scaling-view';

export default class ScalingApply extends Command {
  static readonly description =
    'Write a scaling group from a file — what a cluster may buy for itself, and where it must stop.\n' +
    'The file is the whole group: a field left out is a field reset to its default, and the same file ' +
    'applied twice leaves the same group. Several groups may live in one file, separated by `---`.\n' +
    '`bounds.max: 0` is a fleet that should hold no nodes, not a group switched off: where the group ' +
    'provisions manually it says every machine present is one somebody attached, and where it provisions ' +
    'automatically it says urgency may buy nothing.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> -f scaling.yaml',
    '<%= config.bin %> <%= command.id %> -f scaling.yaml --dry-run',
    '<%= config.bin %> <%= command.id %> -f scaling.yaml --cluster prod-eu',
  ];

  static readonly flags = {
    file: Flags.string({
      char: 'f',
      description: 'Path to the ScalingGroup YAML/JSON file',
      required: true,
    }),
    cluster: Flags.string({
      char: 'c',
      description:
        'Cluster name or ID, for a file that names none. Refused when the file names a different one.',
    }),
    'dry-run': Flags.boolean({
      description:
        'Read and check the file, say what would be written, and write nothing.',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(ScalingApply);

    let raw: string;
    try {
      raw = fs.readFileSync(flags.file, 'utf8');
    } catch (error: unknown) {
      this.error(`Cannot read ${flags.file}: ${(error as Error).message}`, {
        exit: 1,
      });
    }

    let documents: ScalingGroupDocument[];
    try {
      documents = parseScalingGroupFile(raw, flags.file);
    } catch (error: unknown) {
      if (error instanceof ScalingDocumentError) {
        this.error(error.message, { exit: 1 });
      }
      this.error((error as Error).message, { exit: 1 });
    }

    let client: ScalingClient;
    try {
      client = ScalingClient.open();
    } catch (error: unknown) {
      this.error((error as Error).message, { exit: 1 });
    }

    console.log('');
    for (const document of documents) {
      try {
        await this.applyOne(client, document, flags.cluster, flags['dry-run']);
      } catch (error: unknown) {
        const [first, ...rest] = scalingErrorLines(error);
        console.log(chalk.red(`  ✖ ${document.group.name}: ${first}`));
        for (const line of rest) console.log(chalk.red(`    ${line}`));
        console.log('');
        this.exit(1);
      }
    }

    if (flags['dry-run']) {
      console.log(chalk.dim('  Nothing was written.\n'));
    }
  }

  private async applyOne(
    client: ScalingClient,
    document: ScalingGroupDocument,
    clusterFlag: string | undefined,
    dryRun: boolean,
  ): Promise<void> {
    const named = document.cluster;
    if (named && clusterFlag && !sameCluster(named, clusterFlag)) {
      throw new Error(
        `the file names cluster "${named}" and --cluster says "${clusterFlag}"`,
      );
    }
    const wanted = named ?? clusterFlag;
    if (!wanted) {
      throw new Error(
        'no cluster: add `cluster:` to the file, or pass --cluster',
      );
    }

    const cluster = await resolveClusterRef(wanted);
    const existing = await client.groupsOf(cluster.id);
    const previous = existing.find(
      (g) => g.name.toLowerCase() === document.group.name.toLowerCase(),
    );

    if (dryRun) {
      const verb = previous ? 'update' : 'create';
      console.log(
        `  ${chalk.cyan('•')} would ${verb} ${chalk.bold(document.group.name)} on ${chalk.bold(cluster.name)}`,
      );
      this.printGroup(document, cluster.name, previous);
      return;
    }

    const written = previous
      ? await client.update(previous.id, document.group)
      : await client.create(cluster.id, document.group);

    console.log(
      `  ${chalk.green('✔')} ${previous ? 'Updated' : 'Created'} ${chalk.bold(written.name)} on ${chalk.bold(written.clusterName)}`,
    );
    this.printWritten(written);
  }

  private printGroup(
    document: ScalingGroupDocument,
    clusterName: string,
    previous?: ScalingGroupResponseDto,
  ): void {
    const group = document.group;
    console.log(chalk.dim(`    bounds     ${formatBounds(group.bounds)}`));
    console.log(chalk.dim(`    strategy   ${group.strategy}`));
    console.log(chalk.dim(`    provision  ${group.provision}`));
    if (previous) {
      console.log(
        chalk.dim(
          `    overwrites the group of the same name on ${clusterName}, each block replaced whole`,
        ),
      );
    }
    console.log('');
  }

  private printWritten(group: ScalingGroupResponseDto): void {
    console.log(chalk.dim(`    bounds     ${formatBounds(group.bounds)}`));
    console.log(
      chalk.dim(`    strategy   ${describeStrategy(group.strategy)}`),
    );
    console.log(
      chalk.dim(`    settle     ${describeSettle(group.settleSeconds)}`),
    );
    console.log(chalk.dim(`    provision  ${group.provision}`));
    console.log(chalk.dim(`    ${describeCapability(group.capability)}`));
    console.log(
      chalk.dim('    Ask what it decided, and why, with `flui scaling why`.'),
    );
    console.log('');
  }
}

function sameCluster(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
