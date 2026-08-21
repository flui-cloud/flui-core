import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { CatalogClient, CatalogInstall } from '../../lib/catalog-client';
import { resolveClusterRef } from '../../lib/resolve-cluster';
import { printContextBanner } from '../../lib/context-banner';

function colorStatus(status: string): string {
  switch (status) {
    case 'RUNNING':
      return chalk.green(status);
    case 'FAILED':
      return chalk.red(status);
    case 'PENDING':
    case 'INSTALLING':
      return chalk.cyan(status);
    default:
      return status;
  }
}

function parsePairs(pairs: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs ?? []) {
    const eq = p.indexOf('=');
    if (eq < 1) {
      throw new Error(`Expected KEY=value, got "${p}"`);
    }
    out[p.slice(0, eq)] = p.slice(eq + 1);
  }
  return out;
}

export default class CatalogInstallCmd extends Command {
  static readonly id = 'catalog:install';
  static readonly description = 'Install a catalog application on a cluster';
  static readonly examples = [
    '<%= config.bin %> <%= command.id %> umami',
    '<%= config.bin %> <%= command.id %> umami --name "Umami" --wait',
    '<%= config.bin %> <%= command.id %> penpot --input ADMIN_EMAIL=me@example.com --wait',
  ];
  static readonly args = {
    slug: Args.string({
      description: 'Catalog slug, as listed by `flui catalog list`',
      required: true,
    }),
  };
  static readonly flags = {
    cluster: Flags.string({ description: 'Cluster name or id' }),
    name: Flags.string({ description: 'Display name (defaults to the slug)' }),
    domain: Flags.string({
      description:
        'Custom FQDN. Omitted, the cluster zone assigns <install>.<zone>',
    }),
    input: Flags.string({
      multiple: true,
      description: 'Answer to a manifest prompt, as KEY=value (repeatable)',
    }),
    env: Flags.string({
      multiple: true,
      description: 'Override a userEditable env entry, as KEY=value',
    }),
    'skip-endpoint': Flags.boolean({
      default: false,
      description: 'Install without DNS and TLS; configure them later',
    }),
    'allow-master-placement': Flags.boolean({
      default: false,
      description:
        'Let dedicated-storage components run on the control-plane node, for a cluster with no worker',
    }),
    wait: Flags.boolean({
      default: false,
      description: 'Poll until the install leaves PENDING/INSTALLING',
    }),
    timeout: Flags.integer({
      default: 900,
      description: 'Seconds to wait with --wait',
    }),
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(CatalogInstallCmd);
    printContextBanner();

    const cluster = await resolveClusterRef(flags.cluster);
    const catalog = CatalogClient.fromConfig();

    let install = await catalog.install(args.slug, {
      clusterId: cluster.id,
      displayName: flags.name ?? args.slug,
      domain: flags.domain,
      skipEndpoint: flags['skip-endpoint'],
      allowMasterPlacement: flags['allow-master-placement'],
      userInputs: parsePairs(flags.input),
      envOverrides: parsePairs(flags.env),
    });

    if (flags.wait) {
      install = await this.pollUntilSettled(catalog, install, flags.timeout);
    }

    if (flags.json) {
      this.log(JSON.stringify({ cluster, install }, null, 2));
      return;
    }

    this.log('');
    this.log(`   ${chalk.bold(install.displayName)}  ${chalk.dim(install.id)}`);
    this.log(`   state    ${colorStatus(install.status)}`);
    if (install.resolvedFqdn) {
      this.log(`   url      https://${install.resolvedFqdn}`);
    }
    if (install.errorMessage) {
      this.log(`   ${chalk.red('why')}      ${install.errorMessage}`);
    }
    this.log(
      flags.wait
        ? ''
        : chalk.dim(`\n   Follow it with: flui catalog status ${install.id}\n`),
    );

    if (install.status === 'FAILED') this.exit(1);
  }

  private async pollUntilSettled(
    catalog: CatalogClient,
    initial: CatalogInstall,
    timeoutSeconds: number,
  ): Promise<CatalogInstall> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    let current = initial;
    let lastStatus = '';
    while (
      (current.status === 'PENDING' || current.status === 'INSTALLING') &&
      Date.now() < deadline
    ) {
      if (current.status !== lastStatus) {
        lastStatus = current.status;
        this.log(chalk.dim(`   ${colorStatus(current.status)}…`));
      }
      await new Promise((r) => setTimeout(r, 5000));
      current = await catalog.getInstall(current.id);
    }
    if (current.status === 'PENDING' || current.status === 'INSTALLING') {
      this.log(
        chalk.yellow(
          `\n   Still installing after ${timeoutSeconds}s — it keeps going without this command.`,
        ),
      );
    }
    return current;
  }
}
