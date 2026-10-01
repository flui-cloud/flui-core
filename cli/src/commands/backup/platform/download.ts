import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import ora from 'ora';
import { BackupClient } from '../../../lib/backup-client';
import { printContextBanner } from '../../../lib/context-banner';

export default class BackupPlatformDownload extends Command {
  static readonly description =
    'Fetch the two files of a platform backup — the key bundle and the control-plane dump — to open them with `flui backup platform restore`. Flui hands out short-lived links, so the storage credentials never leave the API. The files stay sealed to your key.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --job <backup-job-id> --out ./rebuild-input',
  ];

  static readonly flags = {
    job: Flags.string({
      description: 'The backup job to fetch. Defaults to the newest.',
    }),
    out: Flags.string({
      description:
        'Directory to write into (default: ./flui-platform-backup-<job>)',
    }),
    force: Flags.boolean({
      default: false,
      description: 'Overwrite files already in --out',
    }),
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(BackupPlatformDownload);
    if (!flags.json) printContextBanner();

    const spinner = flags.json ? null : ora('Asking for the links...').start();
    try {
      const links = await BackupClient.fromConfig().platformBackupLinks(
        flags.job,
      );
      const outDir = path.resolve(
        flags.out ?? `flui-platform-backup-${links.jobId.slice(0, 8)}`,
      );
      fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });

      const written: Array<{ kind: string; path: string; bytes: number }> = [];
      for (const file of links.files) {
        const target = path.join(outDir, path.basename(file.name));
        if (fs.existsSync(target) && !flags.force) {
          throw new Error(
            `${target} already exists. Pass --force to overwrite, or pick another --out.`,
          );
        }
        if (spinner) spinner.text = `Fetching ${file.name}...`;
        const bytes = await this.fetchTo(file.url, target);
        if (file.sizeBytes > 0 && bytes !== file.sizeBytes) {
          throw new Error(
            `${file.name}: got ${bytes} bytes, the backup recorded ${file.sizeBytes}.`,
          );
        }
        written.push({ kind: file.kind, path: target, bytes });
      }
      spinner?.stop();

      if (flags.json) {
        this.log(
          JSON.stringify(
            { jobId: links.jobId, createdAt: links.createdAt, files: written },
            null,
            2,
          ),
        );
        return;
      }
      this.report(links.jobId, links.createdAt, written);
    } catch (error) {
      spinner?.fail('Could not fetch the platform backup');
      this.error((error as Error).message, { exit: 1 });
    }
  }

  private async fetchTo(url: string, target: string): Promise<number> {
    const response = await fetch(url);
    if (!response.ok || !response.body) {
      throw new Error(
        `The storage answered ${response.status} for ${path.basename(target)}.`,
      );
    }
    await pipeline(
      Readable.fromWeb(response.body as never),
      fs.createWriteStream(target, { mode: 0o600 }),
    );
    return fs.statSync(target).size;
  }

  private report(
    jobId: string,
    createdAt: string,
    written: Array<{ kind: string; path: string; bytes: number }>,
  ): void {
    const bundle = written.find((w) => w.kind === 'keys');
    const dump = written.find((w) => w.kind === 'db');
    this.log('');
    const taken = `taken ${createdAt}`;
    this.log(
      `   ${chalk.green('✔')} Platform backup ${chalk.bold(jobId.slice(0, 8))} ${chalk.dim(taken)}`,
    );
    for (const w of written) {
      const size = `(${w.bytes} bytes)`;
      this.log(`     ${w.path} ${chalk.dim(size)}`);
    }
    this.log('');
    this.log(`   ${chalk.bold('Open it with')}`);
    this.log(
      `     flui backup platform restore --bundle ${bundle?.path} --dump ${dump?.path}`,
    );
    this.log('');
  }
}
