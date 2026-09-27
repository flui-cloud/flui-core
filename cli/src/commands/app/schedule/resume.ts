import { Args, Command, Flags } from '@oclif/core';
import { changeSchedule } from './update';

export default class AppScheduleResume extends Command {
  static readonly description = 'Resume a suspended scheduled job.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-app nightly-cleanup',
  ];

  static readonly args = {
    app: Args.string({
      description: 'Application name or slug',
      required: true,
    }),
    name: Args.string({ description: 'Schedule name', required: true }),
  };

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description: 'Cluster name or ID (default: auto-detect)',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppScheduleResume);
    await changeSchedule(
      this,
      flags.cluster,
      args.app,
      args.name,
      { enabled: true },
      'Resumed',
    );
  }
}
