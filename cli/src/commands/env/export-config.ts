import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getNestApp, closeNestApp } from '../../lib/nest-app';
import { CliControlClusterService } from '../../services/cli-control-cluster.service';
import { CliEndpointResolverService } from '../../services/cli-endpoint-resolver.service';
import { ConfigStorage } from '../../lib/config-storage';
import { ClusterStatus } from 'src/modules/infrastructure/clusters/entities/cluster.entity';
import { updateEnvContent } from '../../lib/utils/env-file';
import { PreferencesResolver } from '../../config/preferences-resolver';
import { echoPreferences } from '../../config/preferences-echo';
import { promptInput } from '../../lib/prompts';
import { PREFERENCES, PreferenceKey } from '../../config/preferences-schema';
import { printContextBanner } from '../../lib/context-banner';

export default class EnvExportConfig extends Command {
  static readonly description =
    'Export cluster endpoints (and non-sensitive defaults) to .env for running the API locally.\n' +
    'Secrets are NOT written by this command — run `flui dev creds` for those, and `flui dev tunnel`\n' +
    'to expose Postgres/Redis/etc. on localhost.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --dry-run',
    '<%= config.bin %> <%= command.id %> --no-backup',
  ];

  static readonly flags = {
    'dry-run': Flags.boolean({
      description: 'Show what would be changed without modifying .env',
      default: false,
    }),
    backup: Flags.boolean({
      description: 'Create backup of existing .env file',
      default: true,
      allowNo: true,
    }),
    force: Flags.boolean({
      description: 'Skip confirmation prompt',
      default: false,
    }),
    'no-dashboard': Flags.boolean({
      description: 'Skip updating the dashboard config.json',
      default: false,
    }),
    'api-path': Flags.string({
      description: `Override resolved value for the "apiPath" preference (${PREFERENCES.apiPath.description})`,
    }),
    'dashboard-path': Flags.string({
      description: `Override resolved value for the "dashboardPath" preference (${PREFERENCES.dashboardPath.description})`,
    }),
    'certificate-mode': Flags.string({
      description: `Override resolved value for the "certificateMode" preference (one of: ${PREFERENCES.certificateMode.allowedValues.join(', ')})`,
      options: [...PREFERENCES.certificateMode.allowedValues] as string[],
    }),
    email: Flags.string({
      description: `Override resolved value for the "email" preference (${PREFERENCES.email.description})`,
    }),
    save: Flags.boolean({
      description:
        'Persist any value entered at the interactive prompt to the active profile (~/.flui/profiles/<active>/config.json). Without this flag, prompted values are used only for this run.',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(EnvExportConfig);
    printContextBanner();
    let spinner = ora('Reading cluster configuration...').start();

    try {
      const app = await getNestApp();
      const controlService = app.get(CliControlClusterService);
      const resolver = app.get(CliEndpointResolverService);

      const cluster = await controlService.getControlCluster();

      if (!cluster) {
        spinner.fail('No control cluster found');
        console.log(chalk.yellow('\n⚠️  No control cluster exists.\n'));
        console.log(chalk.dim('Create one with:'));
        console.log(`   ${chalk.cyan('flui env create')}\n`);
        return;
      }

      if (cluster.status !== ClusterStatus.READY) {
        spinner.fail(`Cluster is not ready (status: ${cluster.status})`);
        console.log(
          chalk.yellow(
            '\n⚠️  Cluster must be in READY status to export configuration.\n',
          ),
        );
        return;
      }

      const masterIp = cluster.masterIpAddress;
      if (!masterIp) {
        spinner.fail('Master IP address not available');
        return;
      }

      spinner.succeed('Cluster configuration loaded');

      spinner = ora('Resolving endpoints from cluster...').start();
      const endpoints = await resolver.resolveEndpoints(
        masterIp,
        cluster.nipHostnameToken,
      );
      spinner.succeed('Endpoints resolved');

      // Written to .env.local by `flui dev creds` (reads flui-secrets over SSH+kubectl).
      const adminEmail = '';
      const sshCaPublicKey = '';

      const authMode =
        endpoints.authMode === 'unknown' ? 'local' : endpoints.authMode;
      const resolvedIssuer = this.resolveIssuer(endpoints);
      const resolvedJwks = this.resolveJwks(endpoints, resolvedIssuer);

      console.log(chalk.cyan('\n📋 Exporting Cluster Configuration\n'));
      console.log(`   ${chalk.bold('Cluster:')}    ${cluster.name}`);
      console.log(`   ${chalk.bold('Master IP:')}  ${masterIp}`);
      console.log(`   ${chalk.bold('Status:')}     ${cluster.status}\n`);

      console.log(
        chalk.cyan('⚙️  Configuration to export (endpoints only):\n'),
      );
      console.log(
        `   DB_HOST=127.0.0.1   ${chalk.dim('# via `flui dev tunnel`')}`,
      );
      console.log(`   DB_PORT=5432`);
      console.log(`   DB_USERNAME=fluicloud`);
      console.log(`   DB_NAME=fluicloud`);
      console.log(`   REDIS_HOST=127.0.0.1`);
      console.log(`   REDIS_PORT=6379`);
      console.log(`   KUBECONFIG_SERVER_OVERRIDE=https://127.0.0.1:6443`);
      console.log(
        `   GRAFANA_URL=http://localhost:3001        ${chalk.dim('# via `flui dev tunnel --ports grafana`')}`,
      );
      console.log(
        `   PROMETHEUS_ENDPOINT=http://localhost:9090 ${chalk.dim('# via `flui dev tunnel --ports vmsingle`')}`,
      );
      console.log(
        `   LOKI_ENDPOINT=http://localhost:3100       ${chalk.dim('# via `flui dev tunnel --ports loki`')}`,
      );
      if (resolvedIssuer || authMode === 'oidc') {
        console.log(
          `   OIDC_ISSUER=${resolvedIssuer || chalk.dim('(not set)')}`,
        );
        console.log(
          `   OIDC_JWKS_URI=${resolvedJwks || chalk.dim('(not set)')}`,
        );
        console.log(
          `   OIDC_AUDIENCE=${endpoints.oidcAudience || chalk.dim('(set after first Zitadel setup)')}`,
        );
        const adminUrlPreview = endpoints.zitadel.fqdn
          ? `https://${endpoints.zitadel.fqdn}`
          : chalk.dim('(zitadel ingress not found)');
        console.log(`   OIDC_PROVIDER_ADMIN_URL=${adminUrlPreview}`);
        console.log(
          `   OIDC_CLI_CLIENT_ID=${endpoints.oidcCliClientId || chalk.dim('(not yet provisioned)')}`,
        );
      }
      const publicWebUrlPreview = endpoints.fluiWeb.fqdn
        ? `https://${endpoints.fluiWeb.fqdn}`
        : chalk.dim('(flui-web ingress not found)');
      console.log(`   PUBLIC_WEB_URL=${publicWebUrlPreview}`);
      console.log(`   AUTH_MODE=${authMode}`);
      console.log(`   ADMIN_EMAIL=${adminEmail || chalk.dim('(not set)')}`);
      console.log(
        `   SSH_CA_PUBLIC_KEY=${sshCaPublicKey ? chalk.green('(present)') : chalk.dim('(not set)')}`,
      );
      console.log(
        chalk.dim(
          '\n   Secrets (DB/Redis/JWT/SSH CA private/encryption key) are NOT written here.\n' +
            '   Run `flui dev creds` to populate them in .env.local.\n',
        ),
      );

      if (flags['dry-run']) {
        console.log(
          chalk.yellow('🔍 Dry run mode - no changes will be made\n'),
        );
        return;
      }

      if (!flags.force) {
        console.log(chalk.yellow('⚠️  This will update your .env file.\n'));
        console.log(
          chalk.dim('Use --force to skip this check in automated scripts.\n'),
        );
      }

      // Resolve user preferences once and surface them before any write happens.
      const preferences = await this.resolvePreferences({
        emailFlag: flags.email,
        apiPathFlag: flags['api-path'],
        dashboardPathFlag: flags['dashboard-path'],
        certificateModeFlag: flags['certificate-mode'],
        save: flags.save,
        // Skip the dashboardPath/certificateMode prompts entirely when the user opted out.
        skipDashboard: flags['no-dashboard'],
      });

      spinner = ora('Updating .env file...').start();

      const apiDir = path.isAbsolute(preferences.apiPath)
        ? preferences.apiPath
        : path.resolve(process.cwd(), preferences.apiPath);
      const envPath = path.join(apiDir, '.env');
      const envExamplePath = path.join(apiDir, '.env.example');

      let envContent = '';
      if (fs.existsSync(envPath)) {
        envContent = fs.readFileSync(envPath, 'utf-8');
      } else if (fs.existsSync(envExamplePath)) {
        envContent = fs.readFileSync(envExamplePath, 'utf-8');
        spinner.info('.env not found, using .env.example as template');
      } else {
        spinner.warn('No .env or .env.example found, creating new .env');
      }

      if (flags.backup && fs.existsSync(envPath)) {
        const timestamp = new Date()
          .toISOString()
          .replaceAll(':', '-')
          .replace(/\..+/, '');
        const backupPath = `${envPath}.backup.${timestamp}`;
        fs.copyFileSync(envPath, backupPath);
        spinner.succeed(`Backup created: ${path.basename(backupPath)}`);
      }

      const envVars: Record<string, string> = {
        KUBECONFIG_SERVER_OVERRIDE: 'https://127.0.0.1:6443',
        DB_HOST: '127.0.0.1',
        DB_PORT: '5432',
        DB_USERNAME: 'fluicloud',
        DB_NAME: 'fluicloud',
        REDIS_HOST: '127.0.0.1',
        REDIS_PORT: '6379',
        // Namespace this local API's Bull queues. Only for local developments.
        BULL_PREFIX: 'local-dev',
        GRAFANA_URL: 'http://localhost:3001',
        PROMETHEUS_ENDPOINT: 'http://localhost:9090',
        LOKI_ENDPOINT: 'http://localhost:3100',
        AUTH_MODE: authMode,
      };

      if (resolvedIssuer) envVars.OIDC_ISSUER = resolvedIssuer;
      if (resolvedJwks) envVars.OIDC_JWKS_URI = resolvedJwks;
      if (endpoints.oidcAudience)
        envVars.OIDC_AUDIENCE = endpoints.oidcAudience;
      // Zitadel admin API enforces Host header matching ExternalDomain.
      if (endpoints.zitadel.fqdn)
        envVars.OIDC_PROVIDER_ADMIN_URL = `https://${endpoints.zitadel.fqdn}`;
      // Avoids OidcBootstrapSeeder re-provisioning the CLI app on every boot.
      if (endpoints.oidcCliClientId)
        envVars.OIDC_CLI_CLIENT_ID = endpoints.oidcCliClientId;
      // Consumed by flui-authz install for the login-redirect URL.
      if (endpoints.fluiWeb.fqdn)
        envVars.PUBLIC_WEB_URL = `https://${endpoints.fluiWeb.fqdn}`;

      const resolvedEmail = adminEmail || preferences.email;
      if (resolvedEmail) envVars.ADMIN_EMAIL = resolvedEmail;
      if (sshCaPublicKey) envVars.SSH_CA_PUBLIC_KEY = sshCaPublicKey;

      const updatedEnv = updateEnvContent(envContent, envVars);

      fs.writeFileSync(envPath, updatedEnv, 'utf-8');
      spinner.succeed('.env file updated successfully');

      if (!flags['no-dashboard']) {
        await this.syncDashboardConfig({
          dashboardPath: preferences.dashboardPath,
          certificateMode: preferences.certificateMode,
          authMode,
          oidcIssuer: resolvedIssuer,
          oidcClientId: endpoints.oidcClientId,
          oidcAudience: endpoints.oidcAudience,
          backup: flags.backup,
        });
      }

      console.log(chalk.green('\n✅ Endpoint configuration exported.\n'));
      console.log(chalk.dim('Next steps to run the API locally:'));
      console.log(
        `   1. ${chalk.cyan('flui dev creds')}    ${chalk.dim('# write secrets to .env.local')}`,
      );
      console.log(
        `   2. ${chalk.cyan('flui dev tunnel')}   ${chalk.dim('# expose cluster services on localhost')}`,
      );
      console.log(`   3. ${chalk.cyan('pnpm run start:dev')}\n`);
    } catch (error) {
      spinner.fail('Error exporting configuration');
      console.error(chalk.red(`\n❌ ${error.message}\n`));
      this.exit(1);
    } finally {
      await closeNestApp();
    }
  }

  private async resolvePreferences(opts: {
    emailFlag?: string;
    apiPathFlag?: string;
    dashboardPathFlag?: string;
    certificateModeFlag?: string;
    save: boolean;
    skipDashboard: boolean;
  }): Promise<{
    email?: string;
    apiPath?: string;
    dashboardPath?: string;
    certificateMode?: string;
  }> {
    const storage = new ConfigStorage();
    const resolver = new PreferencesResolver(storage);
    const echoEntries: ReturnType<PreferencesResolver['resolve']>[] = [];
    const out: {
      email?: string;
      apiPath?: string;
      dashboardPath?: string;
      certificateMode?: string;
    } = {};

    const resolveOne = async (
      key: PreferenceKey,
      explicit?: string,
    ): Promise<string | undefined> => {
      const initial = resolver.resolve<string>(key, explicit);
      if (initial.value !== null) {
        echoEntries.push(initial);
        return initial.value;
      }
      const prompted = await this.promptForPreference(key);
      if (opts.save) {
        storage.setPreference(key, prompted);
      }
      echoEntries.push({
        key,
        value: prompted,
        source: opts.save ? 'user' : 'explicit',
      });
      return prompted;
    };

    out.email = await resolveOne('email', opts.emailFlag);
    out.apiPath = await resolveOne('apiPath', opts.apiPathFlag);
    if (!opts.skipDashboard) {
      out.dashboardPath = await resolveOne(
        'dashboardPath',
        opts.dashboardPathFlag,
      );
      out.certificateMode = await resolveOne(
        'certificateMode',
        opts.certificateModeFlag,
      );
    }

    echoPreferences(echoEntries, resolver);
    if (
      !opts.save &&
      echoEntries.some((e) => e.source === 'explicit' || e.source === 'default')
    ) {
      console.log(
        chalk.dim(
          '  ↳ Pass --save to persist prompted/default values to ~/.flui/profiles/<active>/config.json\n',
        ),
      );
    }

    return out;
  }

  private async syncDashboardConfig(opts: {
    dashboardPath: string;
    certificateMode: string;
    authMode: string;
    oidcIssuer: string;
    oidcClientId: string;
    oidcAudience: string;
    backup: boolean;
  }): Promise<void> {
    const dashboardPath = opts.dashboardPath;
    const certificateMode = opts.certificateMode;

    const absoluteDashboardPath = path.isAbsolute(dashboardPath)
      ? dashboardPath
      : path.resolve(process.cwd(), dashboardPath);
    const configPath = path.join(
      absoluteDashboardPath,
      'src',
      'assets',
      'config.json',
    );
    const examplePath = path.join(
      absoluteDashboardPath,
      'src',
      'assets',
      'config.example.json',
    );

    const spinner = ora(`Updating dashboard config (${configPath})...`).start();

    let current: Record<string, unknown> = {};
    if (fs.existsSync(configPath)) {
      try {
        current = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      } catch (err) {
        spinner.fail(
          `Dashboard config.json is not valid JSON (${(err as Error).message}) — skipping`,
        );
        return;
      }
    } else if (fs.existsSync(examplePath)) {
      try {
        current = JSON.parse(fs.readFileSync(examplePath, 'utf-8'));
        spinner.info(
          `config.json missing — seeded from ${path.basename(examplePath)}`,
        );
      } catch (err) {
        spinner.warn(
          `config.example.json is not valid JSON (${(err as Error).message}) — starting from empty config`,
        );
      }
    } else {
      spinner.info(
        'config.json and config.example.json both missing — creating from scratch',
      );
    }

    if (opts.backup && fs.existsSync(configPath)) {
      const timestamp = new Date()
        .toISOString()
        .replaceAll(':', '-')
        .replace(/\..+/, '');
      fs.copyFileSync(configPath, `${configPath}.backup.${timestamp}`);
    }

    const updated = {
      ...current,
      apiBaseUrl: 'http://localhost:3000',
      wsUrl: 'ws://localhost:3000',
      authMode: opts.authMode,
      // Always reflect the resolved cluster — never keep a previous cluster's
      // value. Empty oidcClientId is fine: the dashboard fetches it at runtime.
      oidcIssuer: opts.oidcIssuer || '',
      oidcClientId: opts.oidcClientId || '',
      oidcAudience: opts.oidcAudience || '',
      certificateMode,
    };

    fs.writeFileSync(
      configPath,
      JSON.stringify(updated, null, 2) + '\n',
      'utf-8',
    );
    spinner.succeed(
      `Dashboard config updated (authMode=${opts.authMode}, certificateMode=${certificateMode}, oidcClientId=${opts.oidcClientId ? 'set' : '(empty)'})`,
    );
  }

  private async promptForPreference(key: PreferenceKey): Promise<string> {
    const def = PREFERENCES[key];
    return promptInput({
      message: def.description,
      default: def.defaultValue,
      validate: (v) => PreferencesResolver.validate(key, v),
    });
  }

  private resolveIssuer(endpoints: {
    oidcIssuer: string;
    zitadel: { fqdn: string | null };
  }): string {
    if (endpoints.zitadel.fqdn) return `https://${endpoints.zitadel.fqdn}`;
    if (endpoints.oidcIssuer) return endpoints.oidcIssuer;
    return '';
  }

  private resolveJwks(
    endpoints: { oidcJwksUri: string },
    issuer: string,
  ): string {
    const raw = endpoints.oidcJwksUri;
    const isInCluster = raw.includes('.svc.cluster.local');
    if (raw && !isInCluster) return raw;
    if (issuer) return `${issuer.replace(/\/$/, '')}/oauth/v2/keys`;
    return '';
  }
}
