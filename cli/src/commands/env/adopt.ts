import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { ConfigStorage } from '../../lib/config-storage';
import { CliCaService } from '../../services/cli-ca.service';
import { printContextBanner } from '../../lib/context-banner';

interface ClusterInventory {
  clusterId: string;
  name: string;
  provider: string;
  region: string;
  status: string;
  endpoint: string | null;
  version: string;
  sshCaEnrolled: boolean;
  nodes: {
    id: string;
    name: string;
    type: string;
    publicIp: string | null;
    privateIp: string | null;
    status: string;
  }[];
}

/**
 * Takes ownership of a cluster this machine did not create.
 *
 * A cluster provisioned through app.flui.cloud arrives with SSH dormant: the
 * bootstrap key was destroyed at the end of the run and no certificate
 * authority was ever generated, so `trusted_user_ca_keys` is empty and nothing
 * — ours or anyone else's — can open a shell on those nodes.
 *
 * Adopting is how the owner opens that door, on their own terms:
 *
 *   1. ask the installation to describe itself, and write the local profile
 *   2. generate the SSH CA **here**, so the private key is born where it lives
 *   3. register the public half with the installation
 *   4. have the installation enrol it on every node
 *
 * Step 2 is the point of the whole design. The managed plane never generates a
 * CA and therefore never holds one; the key that opens these servers comes into
 * existence on the operator's machine, at a moment they chose.
 */
export default class EnvAdopt extends Command {
  static readonly description =
    'Take ownership of a cluster created through app.flui.cloud: rebuild the local profile and create the SSH CA on this machine.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> flui_adopt_eyJlbmRwb2ludCI...',
    '<%= config.bin %> <%= command.id %> flui_adopt_eyJlbmRwb2ludCI... --endpoint https://abc123.public.flui.cloud',
  ];

  static readonly args = {
    token: Args.string({
      description: 'Adoption token, shown once at the end of the funnel',
      required: true,
    }),
  };

  static readonly flags = {
    endpoint: Flags.string({
      description:
        'Installation endpoint. Only needed when the token does not carry one (older funnels, or a custom domain).',
    }),
    profile: Flags.string({
      description:
        'Profile to write the adopted cluster into (default: active profile)',
    }),
    'skip-ca': Flags.boolean({
      description:
        'Rebuild the local profile but do not create or enrol an SSH CA. Leaves SSH dormant, which is the right choice if you only ever use the dashboard.',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(EnvAdopt);
    printContextBanner();

    const endpoint = this.resolveEndpoint(args.token, flags.endpoint);
    const spinner = ora(
      'Asking the installation to describe itself...',
    ).start();

    let inventory: ClusterInventory;
    try {
      inventory = await this.fetchInventory(endpoint, args.token);
      spinner.succeed(
        `Found ${inventory.name} — ${inventory.nodes.length} node(s) on ${inventory.provider}/${inventory.region}`,
      );
    } catch (error) {
      spinner.fail('Could not reach the installation');
      this.error(
        `${error instanceof Error ? error.message : String(error)}\n` +
          'Check the endpoint and that the adoption token has not expired — they are valid for one hour.',
        { exit: 1 },
      );
    }

    const configStorage = new ConfigStorage();
    configStorage.saveApiUrl(`${endpoint.replace(/\/$/, '')}/api/v1`);
    this.log(chalk.dim(`   Profile now points at ${endpoint}`));

    if (flags['skip-ca']) {
      this.log(
        chalk.yellow(
          '\nSSH left dormant (--skip-ca). Nothing can open a shell on these nodes, including us.',
        ),
      );
      this.printNext(inventory);
      return;
    }

    const caSpinner = ora('Creating the SSH CA on this machine...').start();
    let publicKey: string;
    try {
      const ca = new CliCaService();
      const result = await ca.getOrCreateCaCertificate();
      publicKey = result.publicKey;
      caSpinner.succeed(
        'SSH CA ready — the private key never left this machine',
      );
    } catch (error) {
      caSpinner.fail('Could not create the SSH CA');
      this.error(error instanceof Error ? error.message : String(error), {
        exit: 1,
      });
    }

    const enrolSpinner = ora(
      'Registering the public key with the installation...',
    ).start();
    try {
      await this.registerPublicKey(endpoint, args.token, publicKey);
      enrolSpinner.succeed('Public key registered');
    } catch (error) {
      enrolSpinner.fail('Registration failed');
      this.error(error instanceof Error ? error.message : String(error), {
        exit: 1,
      });
    }

    this.log(
      chalk.yellow(
        '\n⚠  Node enrolment is not wired up yet.\n' +
          '   The public key is registered, but writing it into /etc/ssh/trusted_user_ca_keys on each\n' +
          '   node has to happen through Kubernetes — SSH is exactly the thing being switched on, so it\n' +
          '   cannot be used to switch it on. Until that job ships, enrol from a machine that already\n' +
          '   has SSH access:  flui env repair-ssh-ca\n',
      ),
    );
    this.printNext(inventory);
  }

  /**
   * The token carries the endpoint it was issued for, so the owner does not
   * have to be told where their own installation lives — one string is the
   * whole handoff.
   *
   * Reading it here is not trusting it: the endpoint only decides who gets
   * asked, and that host then verifies the signature itself. A token pointing
   * somewhere else reaches an installation that will not accept it.
   */
  private resolveEndpoint(token: string, override?: string): string {
    if (override)
      return override.startsWith('http') ? override : `https://${override}`;

    const body = token.replace(/^flui_adopt_/, '').split('.')[0];
    try {
      const payload = JSON.parse(
        Buffer.from(body, 'base64url').toString('utf-8'),
      ) as {
        endpoint?: string;
      };
      if (payload.endpoint) return payload.endpoint.replace(/\/$/, '');
    } catch {
      // Falls through to the same error as an endpoint-less token.
    }

    this.error(
      'That token does not name an installation. Pass --endpoint with the address of the one you are adopting.',
      { exit: 1 },
    );
  }

  private async fetchInventory(
    endpoint: string,
    token: string,
  ): Promise<ClusterInventory> {
    const res = await fetch(
      `${endpoint.replace(/\/$/, '')}/api/v1/adoption/inventory`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) {
      throw new Error(
        `The installation replied ${res.status} ${res.statusText}.`,
      );
    }
    return (await res.json()) as ClusterInventory;
  }

  private async registerPublicKey(
    endpoint: string,
    token: string,
    publicKey: string,
  ): Promise<void> {
    const res = await fetch(
      `${endpoint.replace(/\/$/, '')}/api/v1/adoption/ca/register`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ publicKey }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) {
      throw new Error(
        `The installation replied ${res.status} ${res.statusText}.`,
      );
    }
  }

  private printNext(inventory: ClusterInventory): void {
    this.log(chalk.cyan('\n📋 Adopted:\n'));
    this.log(`   ${chalk.dim('Cluster:')}  ${inventory.name}`);
    this.log(
      `   ${chalk.dim('Provider:')} ${inventory.provider} · ${inventory.region}`,
    );
    this.log(`   ${chalk.dim('Version:')}  ${inventory.version}`);
    this.log(chalk.cyan('\n📊 Next:\n'));
    this.log(`   ${chalk.cyan('flui env status')}   check the installation`);
    this.log(`   ${chalk.cyan('flui app list')}     see what is running\n`);
  }
}
