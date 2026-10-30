import { Args, Command, Flags } from '@oclif/core';
import { getNestApp, closeNestApp } from '../../lib/nest-app';
import { printContextBanner } from '../../lib/context-banner';
import {
  openControlPlane,
  printControlPlaneError,
} from '../../lib/control-plane-api';
import { resizeNode } from '../../lib/node-resize';

export default class EnvScaleNode extends Command {
  static readonly description =
    'Vertically scale a worker node of the control cluster to a new server type. Planned-maintenance operation: ' +
    'the node is off for 3-5 minutes. For the master, use `flui env scale-master`; for a node of a workload cluster, `flui node resize`.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> worker-1 --type cx32',
    '<%= config.bin %> <%= command.id %> worker-1 --type PRO2-S --confirm',
  ];

  static readonly args = {
    name: Args.string({
      description: 'Worker node name (e.g. flui-cluster-worker-1)',
      required: true,
    }),
  };

  static readonly flags = {
    type: Flags.string({
      char: 't',
      description:
        'Target provider server type name. If omitted, auto-picks the next-bigger upgrade candidate (smallest +€/month delta).',
    }),
    upgradeDisk: Flags.boolean({
      description: '[Hetzner] Also grow the local OS disk (one-way).',
      default: false,
    }),
    copiesGib: Flags.integer({
      description:
        'Grow the space this node sets aside for copies of replicated volumes to this many GiB once it is back',
      min: 1,
    }),
    confirm: Flags.boolean({
      description: 'Skip the typed confirmation prompt',
      default: false,
    }),
    wait: Flags.boolean({
      description:
        'Follow the resize until it ends (--no-wait returns once it is queued)',
      default: true,
      allowNo: true,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(EnvScaleNode);
    printContextBanner();
    try {
      const { cluster, api } = await openControlPlane(await getNestApp());
      const ok = await resizeNode(api, cluster.id, args.name, {
        type: flags.type,
        upgradeDisk: flags.upgradeDisk,
        copiesGib: flags.copiesGib,
        confirm: flags.confirm,
        wait: flags.wait,
      });
      if (!ok) this.exit(1);
      console.log('');
    } catch (error) {
      printControlPlaneError(error);
      this.exit(1);
    } finally {
      await closeNestApp();
    }
  }
}
