import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { getNestApp, closeNestApp } from '../../lib/nest-app';
import { CliControlClusterService } from '../../services/cli-control-cluster.service';
import { CliSshService } from '../../services/cli-ssh.service';
import { ConfigStorage } from '../../lib/config-storage';
import { EncryptionService } from 'src/modules/shared/encryption/services/encryption.service';
import { ClusterStatus } from 'src/modules/infrastructure/clusters/entities/cluster.entity';
import {
  resolveClusterSshTarget,
  SshTarget,
} from '../../lib/cluster-ssh-target';
import { updateEnvContent } from '../../lib/utils/env-file';
import { PreferencesResolver } from '../../config/preferences-resolver';
import { promptInput } from '../../lib/prompts';
import { PREFERENCES, PreferenceKey } from '../../config/preferences-schema';

interface FluiSecrets {
  jwtSecret?: string;
  adminEmail?: string;
  fluiApiKey?: string;
  sshCaPrivateKey?: string;
  sshCaPublicKey?: string;
  zitadelPat?: string;
  /**
   * Seals provider credentials and SSH private keys. Without it a local API
   * falls back to a key published in the source tree — and since local
   * development runs against the instance's own database, anything it creates
   * lands there sealed with a key anyone can read.
   */
  sshKeyEncryptionKey?: string;
}

export default class DevCreds extends Command {
  static readonly description =
    'Developer-only: write cluster secrets (DB/Redis passwords, JWT, encryption key, SSH CA) to <apiPath>/.env.local for local development.\n' +
    '.env.local is gitignored. Run `flui dev tunnel` to expose the matching services on localhost.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --dry-run',
    '<%= config.bin %> <%= command.id %> --api-path ../flui-core',
  ];

  static readonly flags = {
    'dry-run': Flags.boolean({
      description:
        'Print which keys would be written without touching the file',
      default: false,
    }),
    backup: Flags.boolean({
      description:
        'Create a backup of an existing .env.local before overwriting keys',
      default: true,
      allowNo: true,
    }),
    'api-path': Flags.string({
      description: `Override resolved value for the "apiPath" preference (${PREFERENCES.apiPath.description})`,
    }),
    save: Flags.boolean({
      description:
        'Persist any prompted preference value to the active profile (~/.flui/profiles/<active>/config.json).',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(DevCreds);
    let spinner = ora('Reading cluster configuration...').start();

    try {
      const app = await getNestApp();
      const controlService = app.get(CliControlClusterService);
      const encryptionService = app.get(EncryptionService);
      const sshService = app.get(CliSshService);

      const cluster = await controlService.getControlCluster();
      if (!cluster) {
        spinner.fail('No control cluster found');
        return;
      }
      if (cluster.status !== ClusterStatus.READY) {
        spinner.fail(`Cluster not ready (status: ${cluster.status})`);
        return;
      }
      const masterIp = cluster.masterIpAddress;
      if (!masterIp) {
        spinner.fail('Master IP address not available');
        return;
      }
      spinner.succeed('Cluster ready');

      // Stack passwords (Postgres, Redis, Grafana) from DB metadata.
      spinner = ora('Resolving stack passwords...').start();
      const passwords = this.resolveStackPasswords(cluster, encryptionService);
      if (!passwords) {
        spinner.fail('Stack passwords not available in cluster metadata');
        return;
      }
      spinner.succeed('Stack passwords resolved');

      // flui-secrets via SSH + kubectl on the master (avoids needing kube-API
      // open or a running tunnel). Falls back gracefully if the secret is missing.
      spinner = ora('Reading flui-secrets via SSH...').start();
      const fluiSecrets = await this.readFluiSecrets(
        sshService,
        resolveClusterSshTarget(cluster, masterIp),
      );
      spinner.succeed('flui-secrets read');

      // Local encryption key — shared with API via ~/.flui/encryption.key.
      const encryptionKeyPath = path.join(
        os.homedir(),
        '.flui',
        'encryption.key',
      );
      const encryptionKey = fs.existsSync(encryptionKeyPath)
        ? fs.readFileSync(encryptionKeyPath, 'utf-8').trim()
        : '';

      const apiPath = await this.resolveApiPath(flags['api-path'], flags.save);
      const apiDir = path.isAbsolute(apiPath)
        ? apiPath
        : path.resolve(process.cwd(), apiPath);
      const envLocalPath = path.join(apiDir, '.env.local');

      const envVars = this.buildEnvVars({
        passwords,
        encryptionKey,
        fluiSecrets,
      });

      this.printSummary(envLocalPath, envVars);

      // Instances installed before the bootstrap started generating this key do
      // not have one. Saying so is the point: without it the local API seals new
      // provider credentials with a key published in the source tree, and it
      // writes them to this instance's own database.
      if (!fluiSecrets.sshKeyEncryptionKey) {
        console.log(
          chalk.yellow(
            '\n⚠️  SSH_KEY_ENCRYPTION_KEY is not in this instance’s flui-secrets.\n' +
              '   The local API will seal provider credentials and SSH keys with the\n' +
              '   retired default key, which is published in the source tree.\n',
          ),
        );
      }

      if (fluiSecrets.fluiApiKey) {
        // Mirror existing export-config behavior: keep ~/.flui/config.json
        // in sync so that `flui` commands can call the API right away.
        new ConfigStorage().setApiKey(fluiSecrets.fluiApiKey);
      }

      if (flags['dry-run']) {
        console.log(chalk.yellow('🔍 Dry run — .env.local not modified\n'));
        return;
      }

      this.writeEnvFile(envLocalPath, apiDir, envVars, !!flags.backup);

      console.log(chalk.green(`\n✅ Wrote secrets to ${envLocalPath}\n`));
      console.log(chalk.dim('Next steps:'));
      console.log(
        `   1. ${chalk.cyan('flui dev tunnel')}  (in another terminal)`,
      );
      console.log(`   2. ${chalk.cyan('pnpm start:dev')}\n`);
    } catch (error) {
      spinner.fail('Error writing dev credentials');
      console.error(chalk.red(`\n❌ ${(error as Error).message}\n`));
      this.exit(1);
    } finally {
      await closeNestApp();
    }
  }

  private resolveStackPasswords(
    cluster: { metadata?: Record<string, unknown> },
    encryptionService: EncryptionService,
  ): { postgres: string; redis: string; grafana: string } | null {
    const metadata = (cluster.metadata ?? {}) as Record<string, any>;
    const stack = metadata.observabilityStack?.passwords as
      | { postgres: string; redis: string; grafana: string }
      | undefined;
    if (stack) return stack;

    if (
      metadata.postgresPasswordEncrypted &&
      metadata.redisPasswordEncrypted &&
      metadata.grafanaPasswordEncrypted
    ) {
      try {
        return {
          postgres: encryptionService.decrypt(
            metadata.postgresPasswordEncrypted,
          ),
          redis: encryptionService.decrypt(metadata.redisPasswordEncrypted),
          grafana: encryptionService.decrypt(metadata.grafanaPasswordEncrypted),
        };
      } catch {
        return null;
      }
    }
    return null;
  }

  private buildEnvVars(opts: {
    passwords: { postgres: string; redis: string; grafana: string };
    encryptionKey: string;
    fluiSecrets: FluiSecrets;
  }): Record<string, string> {
    const { passwords, encryptionKey, fluiSecrets } = opts;
    const envVars: Record<string, string> = {
      DB_PASSWORD: passwords.postgres,
      REDIS_PASSWORD: passwords.redis,
      GRAFANA_ADMIN_PASSWORD: passwords.grafana,
    };
    if (encryptionKey) envVars.ENCRYPTION_KEY = encryptionKey;
    if (fluiSecrets.adminEmail) envVars.ADMIN_EMAIL = fluiSecrets.adminEmail;
    if (fluiSecrets.jwtSecret) envVars.JWT_SECRET = fluiSecrets.jwtSecret;
    if (fluiSecrets.fluiApiKey) envVars.FLUI_API_KEY = fluiSecrets.fluiApiKey;
    if (fluiSecrets.sshCaPrivateKey)
      envVars.SSH_CA_PRIVATE_KEY = fluiSecrets.sshCaPrivateKey;
    if (fluiSecrets.sshCaPublicKey)
      envVars.SSH_CA_PUBLIC_KEY = fluiSecrets.sshCaPublicKey;
    if (fluiSecrets.zitadelPat)
      envVars.ZITADEL_SERVICE_ACCOUNT_PAT = fluiSecrets.zitadelPat;
    if (fluiSecrets.sshKeyEncryptionKey)
      envVars.SSH_KEY_ENCRYPTION_KEY = fluiSecrets.sshKeyEncryptionKey;
    return envVars;
  }

  private writeEnvFile(
    envLocalPath: string,
    apiDir: string,
    envVars: Record<string, string>,
    backup: boolean,
  ): void {
    let existing = '';
    if (fs.existsSync(envLocalPath)) {
      existing = fs.readFileSync(envLocalPath, 'utf-8');
      if (backup) {
        const stamp = new Date()
          .toISOString()
          .replaceAll(':', '-')
          .replace(/\..+/, '');
        fs.copyFileSync(envLocalPath, `${envLocalPath}.backup.${stamp}`);
      }
    } else {
      existing =
        '# Local-only secrets written by `flui dev creds`. Do NOT commit.\n';
    }

    const updated = updateEnvContent(existing, envVars);
    fs.mkdirSync(apiDir, { recursive: true });
    fs.writeFileSync(envLocalPath, updated, { mode: 0o600 });
    try {
      fs.chmodSync(envLocalPath, 0o600);
    } catch {
      /* best-effort */
    }
  }

  private async readFluiSecrets(
    sshService: CliSshService,
    ssh: SshTarget,
  ): Promise<FluiSecrets> {
    try {
      const raw = await sshService.sshExec(
        ssh.host,
        "kubectl -n flui-system get secret flui-secrets -o jsonpath='{.data}'",
        ssh.user,
        ssh.port,
      );
      const data = JSON.parse(raw) as Record<string, string>;
      const decode = (v?: string) =>
        v ? Buffer.from(v, 'base64').toString('utf-8') : undefined;
      return {
        jwtSecret: decode(data.JWT_SECRET),
        adminEmail: decode(data.ADMIN_EMAIL),
        fluiApiKey: decode(data.FLUI_API_KEY),
        sshCaPrivateKey: decode(data.SSH_CA_PRIVATE_KEY),
        sshCaPublicKey: decode(data.SSH_CA_PUBLIC_KEY),
        zitadelPat: decode(data.ZITADEL_SERVICE_ACCOUNT_PAT),
        sshKeyEncryptionKey: decode(data.SSH_KEY_ENCRYPTION_KEY),
      };
    } catch {
      return {};
    }
  }

  private async resolveApiPath(
    explicit: string | undefined,
    save: boolean,
  ): Promise<string> {
    const storage = new ConfigStorage();
    const resolver = new PreferencesResolver(storage);
    const initial = resolver.resolve<string>('apiPath', explicit);
    if (initial.value !== null) return initial.value;

    const def = PREFERENCES.apiPath;
    const value = await promptInput({
      message: def.description,
      default: def.defaultValue,
      validate: (v) =>
        PreferencesResolver.validate('apiPath' as PreferenceKey, v),
    });
    if (save) storage.setPreference('apiPath', value);
    return value;
  }

  private printSummary(
    envLocalPath: string,
    envVars: Record<string, string>,
  ): void {
    console.log(chalk.cyan(`\n📋 Writing to ${envLocalPath}:\n`));
    for (const k of Object.keys(envVars)) {
      console.log(`   ${k}=${chalk.yellow('******')} ${chalk.dim('(hidden)')}`);
    }
    console.log();
  }
}
