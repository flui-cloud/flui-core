import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import {
  RELEASE,
  resolveBootstrapRef,
  resolveImageTags,
} from 'src/config/release.config';
import { getScriptsBaseUrl } from '../config/bootstrap.config';

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

    const tags = resolveImageTags(useLatest);
    const bootstrapRef = resolveBootstrapRef(useLatest);
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
            mode: useLatest ? 'latest' : 'pinned',
            platform: useLatest ? null : RELEASE.version,
            bootstrapRef,
            scriptsBaseUrl,
            bootstrapUrlOverride: urlOverride,
            images: tags,
          },
          null,
          2,
        ),
      );
      return;
    }

    const label = (s: string) => chalk.dim(s.padEnd(15));

    this.log('');
    this.log(chalk.bold('Flui CLI'));
    this.log('');
    this.log(
      `  ${label('CLI')}${chalk.cyan(this.config.version)}  ${chalk.dim(`(${this.config.name})`)}`,
    );
    this.log(
      `  ${label('Platform')}${
        useLatest
          ? chalk.yellow('latest (mobile tags)')
          : `${chalk.cyan(RELEASE.version)}${chalk.dim('  (pinned release)')}`
      }`,
    );
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
    if (!useLatest) {
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
