import { Args, Command } from '@oclif/core';
import ora from 'ora';
import { getNestApp, closeNestApp } from '../../lib/nest-app';
import { printContextBanner } from '../../lib/context-banner';
import {
  openControlPlane,
  printControlPlaneError,
} from '../../lib/control-plane-api';
import { findClusterNode } from '../../lib/cluster-nodes';

export default class EnvUncordon extends Command {
  static readonly description =
    'Mark a cluster node schedulable again. Recovery helper for when a scale-node ' +
    'operation interrupted before reaching the uncordon step.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> master',
    '<%= config.bin %> <%= command.id %> worker-1',
  ];

  static readonly args = {
    target: Args.string({
      description: 'Node target: "master" or a worker node serverName',
      required: true,
    }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(EnvUncordon);
    printContextBanner();
    const spinner = ora('Resolving node...').start();

    try {
      const { cluster, api } = await openControlPlane(await getNestApp());
      const target = await findClusterNode(api, cluster.id, args.target);

      spinner.text = `Uncordoning ${target.serverName}...`;
      await api.post(
        `/infrastructure/clusters/${cluster.id}/nodes/${target.id}/uncordon`,
        {},
      );
      spinner.succeed(`Node ${target.serverName} is now schedulable`);
      console.log('');
    } catch (error) {
      spinner.fail('Uncordon failed');
      printControlPlaneError(error);
      this.exit(1);
    } finally {
      await closeNestApp();
    }
  }
}
