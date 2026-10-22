import { Command, Flags } from '@oclif/core';
import {
  fleet,
  runTopology,
  topologyFlags,
} from '../../lib/topology/topology-command';

export default class Topology extends Command {
  static readonly description =
    'The fleet as the dashboard Topology shows it: clusters, the apps on them, the servers they run on and what needs attention.\n' +
    'In a terminal it opens a live navigator (Enter opens, Esc goes back, / searches, o opens in the dashboard, q quits); piped or with --no-interactive it prints the fleet.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --no-interactive',
    '<%= config.bin %> <%= command.id %> --watch',
    '<%= config.bin %> <%= command.id %> --json',
    '<%= config.bin %> <%= command.id %> --open',
  ];

  static readonly flags = {
    ...topologyFlags,
    interactive: Flags.boolean({
      description: 'Open the navigator; on by default in a terminal',
      default: true,
      allowNo: true,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Topology);
    const interactive =
      flags.interactive &&
      !flags.json &&
      !flags.open &&
      !flags.watch &&
      !!process.stdin.isTTY &&
      !!process.stdout.isTTY;
    await runTopology(this, flags, fleet, interactive);
  }
}
