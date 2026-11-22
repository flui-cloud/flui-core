import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { writeFileSync } from 'node:fs';
import { IdentityClient } from '../../lib/identity-client';

export default class IdentityExport extends Command {
  static readonly description =
    'Export the users of an identity install, password hashes and one-time-password secrets included, so they can be rebuilt on another install. Passkeys are not exported.';
  static readonly examples = [
    '<%= config.bin %> <%= command.id %> <install-id> --out users.json',
  ];
  static readonly args = {
    install: Args.string({
      description: 'Identity install id',
      required: true,
    }),
  };
  static readonly flags = {
    out: Flags.string({
      required: true,
      description: 'File to write (created readable by you only)',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IdentityExport);
    const data = (await IdentityClient.fromConfig().exportUsers(
      args.install,
    )) as {
      orgs?: Array<{ humanUsers?: unknown[] }>;
    };
    writeFileSync(flags.out, JSON.stringify(data, null, 2), { mode: 0o600 });
    const people = (data.orgs ?? []).reduce(
      (n, o) => n + (o.humanUsers?.length ?? 0),
      0,
    );
    this.log(`${chalk.green('✔')} ${people} people written to ${flags.out}`);
    this.log(
      chalk.yellow(
        '  It holds password hashes: keep it as you would the install itself.',
      ),
    );
  }
}
