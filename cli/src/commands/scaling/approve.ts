import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import {
  ScalingClient,
  resolveGroup,
  scalingErrorLines,
} from '../../lib/scaling-client';

export default class ScalingApprove extends Command {
  static readonly description =
    'Carry out, once, what a manual scaling group proposes: buy the machine it names (floor raised) or give back the node it names (floor lowered). Without --yes it only shows the proposal. Every limit an automatic group meets still holds; the group stays manual and does nothing else on its own.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> general --cluster prod-eu --yes',
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
    yes: Flags.boolean({
      char: 'y',
      description: 'Buy the proposed machine, or give back the named node, now',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ScalingApprove);

    try {
      const client = ScalingClient.open();
      const { group } = await resolveGroup(client, flags.cluster, args.group);
      const preview = await client.preview(group.id);
      const chosen = preview.chosen;
      const giveBack = preview.giveBack;

      if (giveBack && !giveBack.onItsOwn) {
        await this.giveBack(client, group, giveBack.node, flags.yes);
        return;
      }

      if (!chosen?.shape || !chosen.region) {
        console.log(
          chalk.yellow(`\n  ${group.name} proposes nothing to buy right now.`),
        );
        if (preview.blocked) {
          console.log(`  ${preview.blocked.headline}`);
          for (const exit of preview.blocked.exits) {
            console.log(chalk.dim(`    → ${exit.label}`));
          }
        }
        console.log('');
        return;
      }

      const price =
        chosen.hourlyEur === null ? 'price unknown' : `€${chosen.hourlyEur}/h`;
      console.log(
        `\n  ${group.name} proposes a ${chalk.bold(chosen.shape)} in ${chosen.region} (${price}).`,
      );
      if (!flags.yes) {
        console.log(
          chalk.dim('  Nothing bought. Run again with --yes to buy it once.\n'),
        );
        return;
      }

      const decision = await client.approvePurchase(group.id, {
        shape: chosen.shape,
        region: chosen.region,
      });
      console.log(chalk.green(`  ✔ ${decision.did}`));
      if (decision.operation) {
        console.log(
          chalk.dim(
            `  Follow it: flui operation ${decision.operation.id} --follow\n`,
          ),
        );
      }
    } catch (error: unknown) {
      console.log('');
      for (const line of scalingErrorLines(error)) {
        console.log(chalk.red(`  ${line}`));
      }
      console.log('');
      this.exit(1);
    }
  }

  private async giveBack(
    client: ScalingClient,
    group: { id: string; name: string },
    node: string,
    yes: boolean,
  ): Promise<void> {
    console.log(
      `\n  ${group.name} would give back ${chalk.bold(node)}: it is drained and deleted, its work moves to the nodes that stay.`,
    );
    if (!yes) {
      console.log(
        chalk.dim('  Nothing removed. Run again with --yes to give it back.\n'),
      );
      return;
    }
    const removal = await client.approveRemoval(group.id, node);
    console.log(chalk.green(`  ✔ ${removal.did}`));
    if (removal.operation) {
      console.log(
        chalk.dim(
          `  Follow it: flui operation ${removal.operation.id} --follow\n`,
        ),
      );
    }
  }
}
