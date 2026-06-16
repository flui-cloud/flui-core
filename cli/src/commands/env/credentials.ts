import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { getNestApp, closeNestApp } from '../../lib/nest-app';
import { printContextBanner } from '../../lib/context-banner';
import { buildNipBaseDomain } from '../../lib/nip-base-domain.util';
import { CliControlClusterService } from '../../services/cli-control-cluster.service';
import { EncryptionService } from 'src/modules/shared/encryption/services/encryption.service';
import { ClusterStatus } from 'src/modules/infrastructure/clusters/entities/cluster.entity';

export default class EnvCredentials extends Command {
  static readonly description =
    'Show how to sign in to your Flui environment: the web/API endpoints, the\n' +
    'bootstrap admin login, and (in OIDC mode) the Zitadel identity provider.\n' +
    'Secrets are hidden by default; pass --show-secrets to print them. Internal\n' +
    'services (Postgres, Redis, Grafana, …) are reached via `flui dev tunnel` /\n' +
    '`flui db tunnel`; for local development use `flui dev creds`.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --format json',
    '<%= config.bin %> <%= command.id %> --show-secrets',
  ];

  static readonly flags = {
    format: Flags.string({
      description: 'Output format (text or json)',
      options: ['text', 'json'],
      default: 'text',
    }),
    'show-secrets': Flags.boolean({
      description:
        'Print secret values in plaintext. Off by default — use `flui dev creds` to write secrets to .env.local instead.',
      default: false,
    }),
  };

  private redact(value: string, show: boolean): string {
    if (!value) return '(not available)';
    return show ? value : '(hidden — pass --show-secrets to reveal)';
  }

  private tryDecrypt(svc: EncryptionService, value?: string): string {
    if (!value) return '';
    try {
      return svc.decrypt(value);
    } catch {
      return '';
    }
  }

  private resolveZitadel(
    clusterMeta: any,
    encryptionService: EncryptionService,
    baseDomain: string,
  ): {
    domain: string;
    masterkey: string;
    adminTempPassword: string;
  } | null {
    if (clusterMeta?.authMode !== 'oidc') return null;
    const domain = clusterMeta?.zitadelDomain || `auth.${baseDomain}`;
    return {
      domain,
      masterkey: this.tryDecrypt(
        encryptionService,
        clusterMeta?.zitadelMasterkeyEncrypted,
      ),
      adminTempPassword: this.tryDecrypt(
        encryptionService,
        clusterMeta?.zitadelAdminTempPasswordEncrypted,
      ),
    };
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(EnvCredentials);
    printContextBanner();
    const spinner = ora('Fetching credentials...').start();

    try {
      const app = await getNestApp();
      const controlService = app.get(CliControlClusterService);
      const encryptionService = app.get(EncryptionService);

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
            '\n⚠️  Cluster must be in READY status to retrieve credentials.\n',
          ),
        );
        return;
      }

      spinner.succeed('Cluster found');

      const masterIp = cluster.masterIpAddress;
      if (!masterIp) {
        spinner.fail('Master IP address not available');
        return;
      }

      const endpoints = await controlService.getObservabilityEndpoints(
        cluster.id,
      );
      const web = endpoints.fluiWeb || 'N/A';
      const api = endpoints.fluiApi || 'N/A';

      const clusterMeta = cluster.metadata as any;
      const baseDomain = buildNipBaseDomain(masterIp, cluster.nipHostnameToken);

      const adminEmail = clusterMeta?.adminEmail || 'admin@flui.cloud';
      const adminPasswordRaw = this.tryDecrypt(
        encryptionService,
        clusterMeta?.adminPasswordEncrypted,
      );

      const zitadelRaw = this.resolveZitadel(
        clusterMeta,
        encryptionService,
        baseDomain,
      );

      const show = flags['show-secrets'];
      // One-time bootstrap password (changed at first login): always shown, unlike --show-secrets values.
      const adminPassword = adminPasswordRaw;
      const zitadel = zitadelRaw
        ? {
            domain: zitadelRaw.domain,
            adminUsername: `flui-admin@zitadel.${zitadelRaw.domain}`,
            adminPassword: zitadelRaw.adminTempPassword
              ? this.redact(zitadelRaw.adminTempPassword, show)
              : '',
            masterkey: zitadelRaw.masterkey
              ? this.redact(zitadelRaw.masterkey, show)
              : '',
            audience: clusterMeta?.zitadelAudience || '',
          }
        : null;

      if (flags.format === 'json') {
        const output = {
          cluster: {
            id: cluster.id,
            name: cluster.name,
            status: cluster.status,
            masterIp,
          },
          endpoints: { fluiWeb: web, fluiApi: api },
          login: {
            admin: {
              email: adminEmail,
              password: adminPassword || '(not available)',
              note: 'Bootstrap credentials — change after first login',
            },
            ...(zitadel && {
              zitadel: {
                console: `https://${zitadel.domain}/ui/console`,
                issuer: `https://${zitadel.domain}`,
                audience: zitadel.audience || '(configure after first setup)',
                adminUsername: zitadel.adminUsername,
                adminPassword: zitadel.adminPassword || '(not available)',
                masterkey: zitadel.masterkey || '(not available)',
              },
            }),
          },
        };
        console.log(JSON.stringify(output, null, 2));
        return;
      }

      this.displayTextOutput(
        { web, api },
        { email: adminEmail, password: adminPassword },
        zitadel,
      );
    } catch (error) {
      spinner.fail('Error retrieving credentials');
      console.error(chalk.red(`\n❌ ${(error as Error).message}\n`));
      this.exit(1);
    } finally {
      await closeNestApp();
    }
  }

  private displayTextOutput(
    endpoints: { web: string; api: string },
    admin: { email: string; password: string },
    zitadel: {
      domain: string;
      adminUsername: string;
      adminPassword: string;
      masterkey: string;
      audience: string;
    } | null,
  ): void {
    console.log(chalk.cyan('\n📋 Control Cluster Credentials'));
    console.log(chalk.cyan('━'.repeat(50)));

    console.log(chalk.cyan('\n🌐 Endpoints:\n'));
    console.log(`   ${chalk.bold('Flui Web:')}  ${endpoints.web}`);
    console.log(`   ${chalk.bold('Flui API:')}  ${endpoints.api}`);

    console.log(chalk.cyan('\n🔑 Login:\n'));
    console.log(`   ${chalk.bold('Flui Admin:')}`);
    console.log(`     ${chalk.dim('Email:')}    ${admin.email}`);
    if (admin.password) {
      console.log(
        `     ${chalk.dim('Password:')} ${chalk.yellow(admin.password)}`,
      );
      console.log(
        `     ${chalk.red('⚠️  Bootstrap credentials — change after first login')}`,
      );
    } else {
      console.log(
        `     ${chalk.dim('Password:')} ${chalk.dim('(not available)')}`,
      );
    }

    if (zitadel) {
      console.log(`\n   ${chalk.bold('Zitadel (Identity Provider):')}`);
      console.log(
        `     ${chalk.dim('Console:')}        https://${zitadel.domain}/ui/console`,
      );
      console.log(
        `     ${chalk.dim('Admin Username:')} ${zitadel.adminUsername}`,
      );
      console.log(
        `     ${chalk.dim('Admin Password:')} ${chalk.yellow(zitadel.adminPassword || 'N/A')}`,
      );
      console.log(
        `     ${chalk.dim('Masterkey:')}      ${chalk.yellow(zitadel.masterkey || 'N/A')}`,
      );
      console.log(
        `     ${chalk.dim('Audience (API):')} ${chalk.dim(zitadel.audience || '(set after first Zitadel console setup)')}`,
      );
      console.log(`     ${chalk.red('⚠️  Sensitive — IdP root admin')}`);
    }

    console.log(); // Empty line at the end
  }
}
