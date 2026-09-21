import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import * as http from 'node:http';
import { ApiClient, ApiError } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';
import {
  findFreeCallbackPort,
  openInBrowser,
  renderPage,
} from '../../lib/browser-callback';

interface InstallUrlResponse {
  alreadyConnected: boolean;
  login?: string;
  installUrl?: string;
  state?: string;
}

interface CallbackResult {
  status: 'connected' | 'error';
  login?: string;
  error?: string;
}

const CONNECT_TIMEOUT_MS = 5 * 60 * 1000;

export default class IntegrationConnect extends Command {
  static readonly description =
    'Connect a third-party integration to your Flui account. Currently supports GitHub: opens a browser to install the Flui GitHub App, then waits for the local callback to confirm the connection.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> github',
    '<%= config.bin %> <%= command.id %> github --headless',
  ];

  static readonly args = {
    provider: Args.string({
      description: 'Integration provider (currently only `github`)',
      required: true,
      options: ['github'],
    }),
  };

  static readonly flags = {
    headless: Flags.boolean({
      description:
        'Print the install URL instead of opening a browser (useful over SSH)',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IntegrationConnect);

    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKeyOrThrow();
    const api = new ApiClient({ baseUrl: apiUrl, apiKey });

    if (args.provider !== 'github') {
      this.error(`Unknown provider "${args.provider}"`, { exit: 1 });
    }

    const port = await findFreeCallbackPort();
    const cliCallbackUrl = `http://127.0.0.1:${port}/callback`;

    const spinner = ora('Requesting GitHub App install URL…').start();
    let install: InstallUrlResponse;
    try {
      install = await api.get<InstallUrlResponse>(
        `/repositories/github-app/install-url?cliCallback=${encodeURIComponent(cliCallbackUrl)}`,
      );
      spinner.stop();
    } catch (error: unknown) {
      spinner.fail('Failed to get install URL');
      this.handleInstallUrlError(error, apiUrl);
      this.exit(1);
    }

    if (install.alreadyConnected) {
      console.log(
        chalk.green(
          `\n  ✔ GitHub is already connected as ${chalk.bold(install.login ?? '?')}.\n`,
        ),
      );
      return;
    }

    if (!install.installUrl) {
      console.log(
        chalk.red(
          '\n  API did not return an install URL. Please retry or contact support.\n',
        ),
      );
      this.exit(1);
    }

    if (flags.headless) {
      console.log('');
      console.log(
        chalk.dim('  Open this URL in a browser to install the GitHub App:'),
      );
      console.log(`  ${chalk.cyan(install.installUrl)}`);
      console.log('');
      console.log(
        chalk.dim(
          `  Waiting for the post-install callback on ${cliCallbackUrl}…`,
        ),
      );
    } else {
      const opened = openInBrowser(install.installUrl);
      if (opened) {
        console.log(
          chalk.dim(`\n  Opened browser to install the Flui GitHub App.`),
        );
      } else {
        console.log(
          chalk.yellow(
            `\n  Could not open browser. Open this URL manually:\n  ${install.installUrl}\n`,
          ),
        );
      }
      console.log(
        chalk.dim(
          `  Waiting for the post-install callback on ${cliCallbackUrl}…`,
        ),
      );
    }

    const result = await this.waitForCallback(port);

    if (result.status === 'connected') {
      console.log(
        chalk.green(
          `\n  ✔ GitHub connected as ${chalk.bold(result.login ?? '?')}.\n`,
        ),
      );
      console.log(
        chalk.dim(
          `  Next: \`flui repo connect <owner/repo>\` to make a repository deployable.\n`,
        ),
      );
      return;
    }

    console.log(chalk.red(`\n  ✖ Connection failed: ${result.error}\n`));
    this.exit(1);
  }

  private handleInstallUrlError(error: unknown, apiUrl: string): void {
    const isNotConfigured =
      error instanceof ApiError &&
      (error.statusCode === 400 ||
        error.statusCode === 404 ||
        error.statusCode === 503) &&
      /not configured|callback url|client_id|not yet configured/i.test(
        error.message,
      );

    if (!isNotConfigured) {
      console.log(chalk.red(`  ${(error as Error).message}`));
      return;
    }

    const dashboardHint = apiUrl.replace(/\/api(\/v1)?$/, '');
    console.log('');
    console.log(
      chalk.yellow(
        "  This Flui instance doesn't have a GitHub integration configured yet.",
      ),
    );
    console.log('');
    console.log(`  Run: ${chalk.cyan('flui integration setup github')}`);
    console.log(
      chalk.dim(`  Or visit: ${dashboardHint}/apps/repositories/github-setup`),
    );
    console.log('');
  }

  private waitForCallback(port: number): Promise<CallbackResult> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        server.close();
        resolve({
          status: 'error',
          error: `timed out after ${CONNECT_TIMEOUT_MS / 1000}s`,
        });
      }, CONNECT_TIMEOUT_MS);

      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
        if (url.pathname !== '/callback') {
          res.writeHead(404);
          res.end();
          return;
        }

        const status = url.searchParams.get('status');
        const login = url.searchParams.get('login');
        const error = url.searchParams.get('error');

        if (status === 'connected' && login) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            renderPage(
              'GitHub connected',
              `<h2>GitHub connected</h2><p>Connected as <code>${login}</code>. You can close this tab and return to the terminal.</p>`,
            ),
          );
          clearTimeout(timer);
          server.close(() => resolve({ status: 'connected', login }));
          return;
        }

        const errMsg = error ?? 'unknown callback shape';
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          renderPage(
            'GitHub connection failed',
            `<h2>Connection failed</h2><p>${errMsg}</p>`,
          ),
        );
        clearTimeout(timer);
        server.close(() => resolve({ status: 'error', error: errMsg }));
      });

      server.listen(port, '127.0.0.1');
    });
  }
}
