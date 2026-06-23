import { Command } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { getNestApp, closeNestApp } from '../../lib/nest-app';
import { buildNipBaseDomain } from '../../lib/nip-base-domain.util';
import { CliControlClusterService } from '../../services/cli-control-cluster.service';
import { CliSshService } from '../../services/cli-ssh.service';
import { printContextBanner } from '../../lib/context-banner';
import {
  resolveClusterSshTarget,
  SshTarget,
} from '../../lib/cluster-ssh-target';

export default class EnvDiagCA extends Command {
  static readonly description = 'Diagnose CA configuration on the cluster';

  static readonly examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<void> {
    printContextBanner();
    const spinner = ora('Connecting to cluster...').start();

    try {
      const app = await getNestApp();
      const controlService = app.get(CliControlClusterService);
      const sshService = app.get(CliSshService);

      const cluster = await controlService.getControlCluster();
      if (!this.assertClusterReady(cluster, spinner)) {
        return;
      }

      spinner.succeed('Connected to cluster');
      console.log(chalk.cyan('\n🔍 CA Diagnostic Report\n'));
      console.log(chalk.dim('─'.repeat(80)));

      const sshT = resolveClusterSshTarget(cluster, cluster.masterIpAddress);
      this.checkLocalCaFiles();
      await this.checkKubernetesSecret(sshService, sshT, spinner);
      await this.checkApiPodEnvironment(sshService, sshT, spinner);
      await this.checkApiCaStatusEndpoint(sshService, cluster, sshT, spinner);

      this.printSummary();

      await closeNestApp();
    } catch (error: any) {
      spinner.fail('Diagnostic failed');
      console.log(chalk.red(`\n❌ Error: ${error.message}\n`));
      await closeNestApp();
      this.exit(1);
    }
  }

  private assertClusterReady(
    cluster: any,
    spinner: any,
  ): cluster is { masterIpAddress: string; nipHostnameToken?: string | null } {
    if (!cluster) {
      spinner.fail('No control cluster found');
      console.log(chalk.yellow('\n⚠️  No control cluster exists.\n'));
      console.log(chalk.dim('Create one with:'));
      console.log(`   ${chalk.cyan('flui env create')}\n`);
      return false;
    }
    if (!cluster.masterIpAddress) {
      spinner.fail('Master IP not available');
      console.log(
        chalk.red('\n❌ Master node does not have an IP address yet\n'),
      );
      return false;
    }
    return true;
  }

  private checkLocalCaFiles(): void {
    console.log(chalk.bold('\n1. CLI CA Files:'));
    const fs = require('node:fs');
    const path = require('node:path');
    const os = require('node:os');

    const caDir = path.join(os.homedir(), '.flui', 'ca');
    const caPrivateKeyPath = path.join(caDir, 'ca_key');
    const caPublicKeyPath = path.join(caDir, 'ca_key.pub');

    const hasPrivateKey = fs.existsSync(caPrivateKeyPath);
    const hasPublicKey = fs.existsSync(caPublicKeyPath);

    console.log(
      `   Private Key: ${hasPrivateKey ? chalk.green('✓ Found') : chalk.red('✗ Missing')} (${caPrivateKeyPath})`,
    );
    console.log(
      `   Public Key:  ${hasPublicKey ? chalk.green('✓ Found') : chalk.red('✗ Missing')} (${caPublicKeyPath})`,
    );

    if (hasPublicKey) {
      const publicKey = fs.readFileSync(caPublicKeyPath, 'utf-8').trim();
      console.log(chalk.dim(`   Preview: ${publicKey.substring(0, 50)}...`));
    }
  }

  private async checkKubernetesSecret(
    sshService: CliSshService,
    ssh: SshTarget,
    spinner: any,
  ): Promise<void> {
    console.log(chalk.bold('\n2. Kubernetes Secret (flui-secrets):'));
    spinner.start('Checking Kubernetes secret...');
    try {
      const secretCheckCmd = `kubectl get secret flui-secrets -n default -o jsonpath='{.data}' 2>&1`;
      const secretOutput = await sshService.sshExec(
        ssh.host,
        secretCheckCmd,
        ssh.user,
        ssh.port,
      );
      const hasPriv = secretOutput.includes('SSH_CA_PRIVATE_KEY');
      const hasPub = secretOutput.includes('SSH_CA_PUBLIC_KEY');
      spinner.succeed('Kubernetes secret checked');
      console.log(
        `   SSH_CA_PRIVATE_KEY: ${hasPriv ? chalk.green('✓ Present') : chalk.red('✗ Missing')}`,
      );
      console.log(
        `   SSH_CA_PUBLIC_KEY:  ${hasPub ? chalk.green('✓ Present') : chalk.red('✗ Missing')}`,
      );
      if (!hasPriv || !hasPub) {
        console.log(
          chalk.yellow('\n   ⚠️  CA keys missing from Kubernetes secret!'),
        );
        console.log(
          chalk.dim('   This is required for the API to access SSH.'),
        );
      }
    } catch (error: any) {
      spinner.fail('Failed to check Kubernetes secret');
      console.log(chalk.red(`   Error: ${error.message}`));
    }
  }

  private async checkApiPodEnvironment(
    sshService: CliSshService,
    ssh: SshTarget,
    spinner: any,
  ): Promise<void> {
    console.log(chalk.bold('\n3. API Pod Environment Variables:'));
    spinner.start('Checking API pod...');
    try {
      const getPodCmd = `kubectl get pods -n default -l app=flui-api -o jsonpath='{.items[0].metadata.name}' 2>&1`;
      const podName = (
        await sshService.sshExec(ssh.host, getPodCmd, ssh.user, ssh.port)
      ).trim();
      if (
        !podName ||
        podName.includes('error') ||
        podName.includes('No resources')
      ) {
        spinner.warn('API pod not found');
        console.log(chalk.yellow('   API pod not found or not running'));
        return;
      }
      const checkEnvCmd = `kubectl exec -n default ${podName} -- env | grep SSH_CA 2>&1 || echo "NOT_FOUND"`;
      const envOutput = await sshService.sshExec(
        ssh.host,
        checkEnvCmd,
        ssh.user,
        ssh.port,
      );
      spinner.succeed(`API pod found: ${podName}`);
      this.reportApiPodEnv(envOutput);
    } catch (error: any) {
      spinner.fail('Failed to check API pod');
      console.log(chalk.red(`   Error: ${error.message}`));
    }
  }

  private reportApiPodEnv(envOutput: string): void {
    const hasPriv = envOutput.includes('SSH_CA_PRIVATE_KEY=');
    const hasPub = envOutput.includes('SSH_CA_PUBLIC_KEY=');
    console.log(
      `   SSH_CA_PRIVATE_KEY env: ${hasPriv ? chalk.green('✓ Set') : chalk.red('✗ Not Set')}`,
    );
    console.log(
      `   SSH_CA_PUBLIC_KEY env:  ${hasPub ? chalk.green('✓ Set') : chalk.red('✗ Not Set')}`,
    );
    if (hasPub) {
      const pubKeyMatch = /SSH_CA_PUBLIC_KEY=(\S+)/.exec(envOutput);
      if (pubKeyMatch) {
        console.log(
          chalk.dim(`   Preview: ${pubKeyMatch[1].substring(0, 50)}...`),
        );
      }
    }
    if (!hasPriv || !hasPub) {
      console.log(
        chalk.yellow('\n   ⚠️  CA environment variables not set in API pod!'),
      );
      console.log(
        chalk.dim(
          '   The API pod may need to be restarted to pick up the secret.',
        ),
      );
      console.log(
        chalk.dim(
          '   Restart command: kubectl rollout restart deployment flui-api -n default',
        ),
      );
    }
  }

  private async checkApiCaStatusEndpoint(
    sshService: CliSshService,
    cluster: { masterIpAddress: string; nipHostnameToken?: string | null },
    ssh: SshTarget,
    spinner: any,
  ): Promise<void> {
    console.log(chalk.bold('\n4. API CA Status Endpoint:'));
    spinner.start('Checking API CA status...');
    try {
      const baseDomain = buildNipBaseDomain(
        cluster.masterIpAddress,
        cluster.nipHostnameToken,
      );
      const apiUrl = `https://api.${baseDomain}/api/v1/access/ca/status`;
      const apiResponse = await sshService.sshExec(
        ssh.host,
        `curl -s -f ${apiUrl} 2>&1`,
        ssh.user,
        ssh.port,
      );
      this.reportApiCaResponse(apiResponse, spinner);
    } catch (error: any) {
      spinner.fail('Failed to check API CA status');
      console.log(chalk.red(`   Error: ${error.message}`));
    }
  }

  private reportApiCaResponse(apiResponse: string, spinner: any): void {
    if (apiResponse.includes('"accessible":true')) {
      spinner.succeed('API can access CA');
      console.log(chalk.green('   ✓ API reports CA is accessible'));
      try {
        const j = JSON.parse(apiResponse);
        console.log(chalk.dim(`   Source: ${j.source || 'unknown'}`));
        console.log(
          chalk.dim(`   Has Private Key: ${j.hasPrivateKey ? 'Yes' : 'No'}`),
        );
        console.log(
          chalk.dim(`   Has Public Key: ${j.hasPublicKey ? 'Yes' : 'No'}`),
        );
      } catch {
        /* */
      }
    } else if (apiResponse.includes('404')) {
      spinner.warn('API CA status endpoint not available');
      console.log(
        chalk.yellow('   ⚠️  The /access/ca/status endpoint is not available'),
      );
      console.log(
        chalk.dim('   This endpoint may not exist in the current API version.'),
      );
    } else {
      spinner.fail('API cannot access CA');
      console.log(chalk.red('   ✗ API reports CA is not accessible'));
      console.log(chalk.dim(`   Response: ${apiResponse.substring(0, 200)}`));
    }
  }

  private printSummary(): void {
    console.log(chalk.dim('\n' + '─'.repeat(80)));
    console.log(chalk.bold('\n📋 Summary & Recommendations:\n'));
    console.log(
      chalk.dim('If CA keys are missing from the Kubernetes secret:'),
    );
    console.log(
      chalk.cyan(
        '   1. The cluster creation may have failed to patch the secret',
      ),
    );
    console.log(
      chalk.cyan('   2. Re-run cluster creation or manually patch the secret'),
    );
    console.log(
      chalk.dim('\nIf secret has keys but API pod environment does not:'),
    );
    console.log(chalk.cyan('   1. Restart the API pod to pick up the secret:'));
    console.log(
      chalk.cyan(
        '      kubectl rollout restart deployment flui-api -n default',
      ),
    );
    console.log(
      chalk.dim('\nIf environment is set but API still cannot access CA:'),
    );
    console.log(chalk.cyan('   1. Check API logs for errors:'));
    console.log(
      chalk.cyan('      kubectl logs -n default -l app=flui-api --tail=50'),
    );
    console.log('');
  }
}
