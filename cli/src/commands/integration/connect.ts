import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import * as http from 'node:http';
import { ApiClient, ApiError } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';
import {
  patErrorLabel,
  printValidation,
  promptForValidPat,
  validatePat,
} from '../../lib/github-pat';
import { stdinRequested, stdinValue } from '../../lib/stdin-value';
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

interface SetupStatus {
  configured: boolean;
  authMethod: 'pat' | 'github_app' | null;
}

interface ConnectionStatus {
  connected: boolean;
  githubUsername?: string;
}

interface CallbackResult {
  status: 'connected' | 'error';
  login?: string;
  error?: string;
}

const CONNECT_TIMEOUT_MS = 5 * 60 * 1000;

export default class IntegrationConnect extends Command {
  static readonly description =
    'Connect your GitHub account to Flui. Where the installation connects GitHub with personal access tokens (the recommended setup) it asks for your token, or reads it with --stdin; where it uses a GitHub App it opens a browser to install the App and waits for the local callback.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> github',
    '<%= config.bin %> <%= command.id %> github --headless',
    'printf %s "$GITHUB_TOKEN" | <%= config.bin %> <%= command.id %> github --stdin',
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
    stdin: Flags.boolean({
      description:
        'Read the personal access token from standard input rather than prompting (installations that use tokens).',
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

    const setup = await api
      .get<SetupStatus>('/repositories/github/setup/status')
      .catch(() => null);
    if (setup && !setup.configured) {
      this.printNotConfigured(apiUrl);
      this.exit(1);
    }
    if (setup?.authMethod === 'pat') {
      await this.connectWithToken(api, flags.headless);
      return;
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

    const result = await this.waitForCallback(port, api);

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

  private async connectWithToken(
    api: ApiClient,
    headless: boolean,
  ): Promise<void> {
    const current = await api
      .get<ConnectionStatus>('/repositories/github/status')
      .catch(() => null);
    if (current?.connected && !stdinRequested()) {
      console.log(
        chalk.green(
          `\n  ✔ GitHub is already connected as ${chalk.bold(current.githubUsername ?? '?')}.`,
        ),
      );
      console.log(
        chalk.dim(
          '  To replace the token, pipe the new one in with --stdin.\n',
        ),
      );
      return;
    }

    let token: string;
    try {
      if (stdinRequested()) {
        token = stdinValue();
        if (!token) this.error('Nothing was read from standard input.');
        const validation = await validatePat(api, token);
        if (!validation.valid) {
          this.error(patErrorLabel(validation.error, validation.message));
        }
        printValidation(validation);
      } else {
        const chosen = await promptForValidPat(api, headless);
        if (!chosen) return;
        token = chosen.token;
      }
      const spinner = ora('Connecting…').start();
      const result = await api
        .post<{ githubUsername?: string }>('/repositories/github/connect-pat', {
          personalAccessToken: token,
        })
        .finally(() => spinner.stop());
      console.log(
        chalk.green(
          `\n  ✔ GitHub connected as ${chalk.bold(result.githubUsername ?? '?')}.\n`,
        ),
      );
      console.log(
        chalk.dim(
          `  Next: \`flui repo connect <owner/repo>\` to make a repository deployable.\n`,
        ),
      );
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        this.error(`${error.statusCode}: ${error.message}`);
      }
      throw error;
    }
  }

  private printNotConfigured(apiUrl: string): void {
    const dashboardHint = apiUrl.replace(/\/api(\/v1)?$/, '');
    console.log('');
    console.log(
      chalk.yellow(
        "  This Flui instance doesn't have a GitHub integration configured yet.",
      ),
    );
    console.log('');
    console.log(
      `  An administrator runs: ${chalk.cyan('flui integration setup github')}`,
    );
    console.log(
      chalk.dim(`  Or visits: ${dashboardHint}/apps/repositories/github-setup`),
    );
    console.log('');
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

    this.printNotConfigured(apiUrl);
  }

  private waitForCallback(
    port: number,
    api: { post<T>(path: string, body: unknown): Promise<T> },
  ): Promise<CallbackResult> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        server.close();
        resolve({
          status: 'error',
          error: `timed out after ${CONNECT_TIMEOUT_MS / 1000}s`,
        });
      }, CONNECT_TIMEOUT_MS);

      const server = http.createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
        if (url.pathname !== '/callback') {
          res.writeHead(404);
          res.end();
          return;
        }

        const claim = url.searchParams.get('claim');
        let status = url.searchParams.get('status');
        let login = url.searchParams.get('login');
        let error = url.searchParams.get('error');
        if (claim) {
          try {
            const connected = await api.post<{ login: string }>(
              '/repositories/github-app/claim',
              { claim },
            );
            status = 'connected';
            login = connected.login;
          } catch (claimError: unknown) {
            error = (claimError as Error).message;
          }
        }

        if (status === 'connected' && login) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            renderPage(
              'GitHub connected',
              `<h2>GitHub connected</h2><p>Connected as <code>${escapeHtml(login)}</code>. You can close this tab and return to the terminal.</p>`,
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
            `<h2>Connection failed</h2><p>${escapeHtml(errMsg)}</p>`,
          ),
        );
        clearTimeout(timer);
        server.close(() => resolve({ status: 'error', error: errMsg }));
      });

      server.listen(port, '127.0.0.1');
    });
  }
}

function escapeHtml(text: string): string {
  return text.replaceAll(/[&<>"']/g, (c) => `&#${c.codePointAt(0)};`);
}
