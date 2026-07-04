import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { DemoClient, DemoConfigInput } from '../../lib/demo-client';
import { printContextBanner } from '../../lib/context-banner';

export default class DemoConfigure extends Command {
  static readonly description =
    'Configure the cross-provider migration demo (admin). Sets the app, its Postgres, the two workload clusters to alternate between, and the URL to probe.';
  static readonly examples = [
    '<%= config.bin %> <%= command.id %> --app-id APP --db-app-id PG --cluster-a A --cluster-b B --probe-url https://demo.example.com/health',
  ];
  static readonly flags = {
    'app-id': Flags.string({ description: 'consumer app to migrate' }),
    'db-app-id': Flags.string({ description: 'its managed Postgres app' }),
    'cluster-a': Flags.string({ description: 'first workload cluster' }),
    'cluster-b': Flags.string({ description: 'second workload cluster' }),
    'probe-url': Flags.string({ description: 'public URL the master probes' }),
    'interval-minutes': Flags.integer({
      description: 'minutes between cycles',
    }),
    'drain-minutes': Flags.integer({ description: 'drain window minutes' }),
    'probe-interval-ms': Flags.integer({ description: 'probe cadence (ms)' }),
    'staging-mode': Flags.string({
      options: ['live-fenced', 'scaled-down'],
      description: 'full-migration staging mode',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(DemoConfigure);
    printContextBanner();
    const input: DemoConfigInput = {
      appId: flags['app-id'],
      dbAppId: flags['db-app-id'],
      clusterAId: flags['cluster-a'],
      clusterBId: flags['cluster-b'],
      probeUrl: flags['probe-url'],
      intervalMinutes: flags['interval-minutes'],
      drainMinutes: flags['drain-minutes'],
      probeIntervalMs: flags['probe-interval-ms'],
      stagingMode: flags['staging-mode'],
    };
    for (const k of Object.keys(input) as (keyof DemoConfigInput)[]) {
      if (input[k] === undefined) delete input[k];
    }
    await DemoClient.fromConfig().configure(input);
    this.log(chalk.green('\n   demo configured.\n'));
  }
}
