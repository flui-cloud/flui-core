import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getScriptsBaseUrl } from '../config/bootstrap.config';
import {
  getEffectiveRelease,
  displayReleaseFilePath,
  type EffectiveRelease,
} from '../config/release-override';

function describePlatform(release: EffectiveRelease): string {
  if (release.source === 'latest') {
    return chalk.yellow('latest (mobile tags)');
  }
  if (release.source === 'override') {
    return `${chalk.yellow(release.version ?? 'override')}${chalk.dim('  (release override)')}`;
  }
  return `${chalk.cyan(release.version ?? '')}${chalk.dim('  (pinned release)')}`;
}

/**
 * `flui version` — surfaces the CLI version AND the platform release it pins.
 *
 * The CLI's npm version is decoupled from the platform release (carried in
 * RELEASE), so this command makes the mapping explicit: which bootstrap ref and
 * which component image tags a `flui env create` would install. Handy when
 * debugging an install ("which versions did this CLI actually use?").
 */
export default class Version extends Command {
  static readonly description =
    'Show the CLI version and the platform release it pins (component image tags + bootstrap ref). Useful for debugging an install.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --latest',
    '<%= config.bin %> <%= command.id %> --json',
  ];

  static readonly flags = {
    latest: Flags.boolean({
      description:
        'Show what `env create --latest` would resolve to (mobile tags: bootstrap master, :latest images) instead of the pinned release',
      default: false,
    }),
    json: Flags.boolean({
      description: 'Output as JSON',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Version);
    const useLatest = flags.latest;

    const release = getEffectiveRelease(useLatest);
    const tags = release.images;
    const bootstrapRef = release.bootstrapRef;
    const scriptsBaseUrl = getScriptsBaseUrl(useLatest);
    const urlOverride = process.env.BOOTSTRAP_SCRIPTS_URL ?? null;

    const images = {
      'flui-api': `ghcr.io/flui-cloud/core:${tags.fluiApi}`,
      'flui-web': `ghcr.io/flui-cloud/dashboard:${tags.fluiWeb}`,
      'flui-authz': `ghcr.io/flui-cloud/flui-authz:${tags.fluiAuthz}`,
    };

    if (flags.json) {
      this.log(
        JSON.stringify(
          {
            cli: this.config.version,
            mode: release.source,
            platform: release.version,
            bootstrapRef,
            scriptsBaseUrl,
            bootstrapUrlOverride: urlOverride,
            releaseFile: release.filePath,
            images: tags,
          },
          null,
          2,
        ),
      );
      return;
    }

    const label = (s: string) => chalk.dim(s.padEnd(15));
    const cliName = chalk.dim(`(${this.config.name})`);
    const platformLabel = describePlatform(release);

    this.log('');
    this.log(chalk.bold('Flui CLI'));
    this.log('');
    this.log(`  ${label('CLI')}${chalk.cyan(this.config.version)}  ${cliName}`);
    this.log(`  ${label('Platform')}${platformLabel}`);
    this.log(`  ${label('Bootstrap ref')}${chalk.cyan(bootstrapRef)}`);
    this.log('');
    this.log(chalk.dim('  Component images:'));
    for (const [name, ref] of Object.entries(images)) {
      this.log(`    ${chalk.dim(name.padEnd(12))}${ref}`);
    }
    this.log('');
    this.log(`  ${label('Scripts URL')}${chalk.dim(scriptsBaseUrl)}`);
    if (urlOverride) {
      this.log(
        `  ${label('')}${chalk.yellow('↑ overridden via BOOTSTRAP_SCRIPTS_URL')}`,
      );
    }
    if (release.source === 'override' && release.filePath) {
      const rel = displayReleaseFilePath(release.filePath);
      this.log(`  ${label('Release file')}${chalk.yellow(rel)}`);
    }
    if (!useLatest && release.source !== 'override') {
      this.log('');
      this.log(
        chalk.dim(
          '  Tip: `flui version --latest` shows what `env create --latest` would use.',
        ),
      );
    }
    this.log('');
  }
}
