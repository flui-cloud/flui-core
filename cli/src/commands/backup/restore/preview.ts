import { Command, Flags } from '@oclif/core';
import { BackupClient } from '../../../lib/backup-client';
import { printContextBanner } from '../../../lib/context-banner';

export default class BackupRestorePreview extends Command {
  static readonly description =
    'Show what a backup holds where it is stored (objects and bytes) before restoring it';
  static readonly flags = {
    artifact: Flags.string({
      required: true,
      description: 'Backup artifact ID',
    }),
    'source-destination': Flags.string({
      required: true,
      description: 'Source destination ID (where the artifact lives)',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(BackupRestorePreview);
    printContextBanner();
    const client = BackupClient.fromConfig();
    const res = await client.previewRestore({
      artifactId: flags.artifact,
      sourceDestinationId: flags['source-destination'],
    });
    this.log(JSON.stringify(res, null, 2));
  }
}
