import { Args, Command, Flags } from '@oclif/core';
import type { ScalingGroupResponseDto } from 'src/modules/infrastructure/scaling/dto/scaling-response.dto';
import { resolveClusterRef } from '../../lib/resolve-cluster';
import {
  ScalingClient,
  resolveGroup,
  scalingErrorLines,
} from '../../lib/scaling-client';
import { dumpScalingGroupDocument } from '../../lib/scaling-file';
import { toScalingGroupDocument } from '../../lib/scaling-view';

export default class ScalingExport extends Command {
  static readonly description =
    'Export a scaling group as a `kind: ScalingGroup` document — the file `flui scaling apply` reads back.\n' +
    'Only what somebody wrote is exported. What the provider can do, and what the market is doing, are ' +
    'read fresh every time and would be stale in a committed file.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> > scaling.yaml',
    '<%= config.bin %> <%= command.id %> general --cluster prod-eu',
    '<%= config.bin %> <%= command.id %> --all --cluster prod-eu > scaling.yaml',
  ];

  static readonly args = {
    group: Args.string({
      description:
        'Scaling group name or ID (default: the only group of the cluster)',
      required: false,
    }),
  };

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description: 'Cluster name or ID (default: auto-detect)',
    }),
    all: Flags.boolean({
      description:
        'Every group of the cluster, as one file of `---` separated documents',
      default: false,
    }),
    output: Flags.string({
      char: 'o',
      description: 'Output format',
      options: ['yaml', 'json'],
      default: 'yaml',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ScalingExport);

    let groups: ScalingGroupResponseDto[];
    try {
      const client = ScalingClient.open();
      if (flags.all) {
        const cluster = await resolveClusterRef(flags.cluster);
        groups = await client.groupsOf(cluster.id);
        if (!groups.length) {
          this.error(`Cluster "${cluster.name}" has no scaling group.`, {
            exit: 1,
          });
        }
      } else {
        const { group } = await resolveGroup(client, flags.cluster, args.group);
        groups = [group];
      }
    } catch (error: unknown) {
      this.error(scalingErrorLines(error).join('\n'), { exit: 1 });
    }

    const documents = groups.map(toScalingGroupDocument);

    if (flags.output === 'json') {
      console.log(
        JSON.stringify(flags.all ? documents : documents[0], null, 2),
      );
      return;
    }

    process.stdout.write(documents.map(dumpScalingGroupDocument).join('---\n'));
  }
}
