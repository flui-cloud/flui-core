import { INestApplication } from '@nestjs/common';
import chalk from 'chalk';
import { ClusterEntity } from 'src/modules/infrastructure/clusters/entities/cluster.entity';
import { CliControlClusterService } from '../services/cli-control-cluster.service';
import { CliClusterCreatorService } from '../services/cli-cluster-creator.service';
import { ApiClient, ApiError } from './api-client';
import { ConfigStorage } from './config-storage';

/**
 * The one way a command asks the control plane about its own cluster.
 *
 * `env firewall apply` and `env firewall status` wrote this shape first: start
 * the module for identity — which cluster is this profile's, and what key can
 * speak for it — and then let every decision travel over HTTP, where the guard
 * chain is. Step 3 converts more commands to it, so the shape lives in one place
 * rather than being copied a sixth time.
 *
 * The credential falls back to the cluster's own machine key, which is what lets
 * a freshly created installation be operated before anybody has run
 * `flui auth login`. When a person *is* logged in, their key wins, and their
 * permissions are the ones that decide.
 */
export interface ControlPlane {
  cluster: ClusterEntity;
  api: ApiClient;
}

/** A failure that happened before any request went out. */
export class ControlPlaneError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'ControlPlaneError';
  }
}

export async function openControlPlane(
  app: INestApplication,
): Promise<ControlPlane> {
  const cluster = await app.get(CliControlClusterService).getControlCluster();
  if (!cluster) {
    throw new ControlPlaneError(
      'No control cluster found',
      `Create one with ${chalk.cyan('flui env create')}.`,
    );
  }

  const config = new ConfigStorage();
  const apiKey =
    config.getApiKey() ||
    app.get(CliClusterCreatorService).getClusterApiKey(cluster);
  if (!apiKey) {
    throw new ControlPlaneError(
      'No credentials to reach the control plane',
      `Run ${chalk.cyan('flui auth login')} first.`,
    );
  }

  return {
    cluster,
    api: new ApiClient({ baseUrl: config.getApiUrlOrThrow(), apiKey }),
  };
}

/**
 * What to add under the error of a command that used to work without the API.
 *
 * This is the cost of the conversion, and it is worth stating on the screen
 * rather than in a release note: an operator who is repairing a broken
 * installation meets it at the worst moment. The answer is the same one the CLI
 * already gives elsewhere — `cluster-listing` degrades to the local store and
 * says so — namely, name the commands that still answer from this machine, since
 * those are precisely the ones step 3 left on the local path on purpose.
 *
 * Returns null for failures that are about the request rather than the reach, so
 * a genuine 400 keeps its own message and gains no misleading advice.
 */
export function controlPlaneHint(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;

  if (error.statusCode === undefined) {
    return (
      'The control plane did not answer.\n' +
      '   This command asks the API so that the same permissions apply here as\n' +
      '   in the dashboard, so there is no local shortcut around it.\n' +
      `   • ${chalk.cyan('flui env status')} still answers from this machine.\n` +
      `   • ${chalk.cyan('flui env restart')} powers stopped servers back on through the provider.`
    );
  }
  if (error.statusCode === 401) {
    return `Not authenticated. Run ${chalk.cyan('flui auth login')}.`;
  }
  if (error.statusCode === 403) {
    return (
      'Your account may not operate infrastructure on this instance.\n' +
      '   Ask an owner for the infrastructure section, or use an account that has it.'
    );
  }
  if (error.statusCode === 404) {
    return (
      'The control plane has no record of this cluster.\n' +
      '   This machine’s store and the instance database can disagree — a cluster\n' +
      `   created by this CLI is registered at bootstrap. Check with ${chalk.cyan('flui env status')}.`
    );
  }
  return null;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'unknown error';
}

/** Prints the message and, when there is one, the hint under it. */
export function printControlPlaneError(error: unknown): void {
  const message = messageOf(error);
  console.log(chalk.red(`\n❌ ${message}\n`));
  const hint =
    error instanceof ControlPlaneError ? error.hint : controlPlaneHint(error);
  if (hint) console.log(chalk.dim(`   ${hint}\n`));
}
