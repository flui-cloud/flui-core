import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import * as http from 'node:http';
import * as os from 'node:os';
import { ApiClient, ApiError } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';
import {
  findFreeCallbackPort,
  openInBrowser,
} from '../../lib/browser-callback';
import {
  selectWithArrows,
  promptInput,
  confirmPrompt,
} from '../../lib/prompts';
import { promptForValidPat } from '../../lib/github-pat';

interface SetupStatus {
  configured: boolean;
  authMethod: 'pat' | 'github_app' | null;
  appSlug?: string;
}

interface ManifestStartResponse {
  manifestJson: Record<string, unknown>;
  githubUrl: string;
  state: string;
}

const MANIFEST_POLL_INTERVAL_MS = 2_000;
const MANIFEST_POLL_TIMEOUT_MS = 10 * 60 * 1000;

export default class IntegrationSetup extends Command {
  static readonly description =
    'Guided GitHub integration setup (admin). Pick Personal Access Token (recommended: each person connects with a classic token) or GitHub App (for teams: creates one App on GitHub via the manifest flow).';

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
      description: 'Print URLs instead of opening a browser',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IntegrationSetup);
    if (args.provider !== 'github') {
      this.error(`Unknown provider "${args.provider}"`, { exit: 1 });
    }

    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKeyOrThrow();
    const api = new ApiClient({ baseUrl: apiUrl, apiKey });

    const status = await this.fetchStatus(api);
    if (status?.configured) {
      console.log(
        chalk.yellow(
          `\n  GitHub integration is already configured (authMethod=${status.authMethod}${status.appSlug ? `, appSlug=${status.appSlug}` : ''}).`,
        ),
      );
      const ok = await confirmPrompt(
        'Overwrite existing configuration?',
        false,
      );
      if (!ok) {
        console.log(chalk.dim('\n  Cancelled.\n'));
        return;
      }
    }

    const choice = await selectWithArrows('Choose setup method', [
      { label: 'Personal Access Token (recommended) — paste a classic PAT' },
      { label: 'GitHub App — for teams, one-click create on GitHub' },
    ]);
    if (choice === -1) {
      console.log(chalk.dim('\n  Cancelled.\n'));
      return;
    }

    if (choice === 0) {
      await this.runPatFlow(api, flags.headless);
    } else {
      await this.runManifestFlow(api, apiUrl, flags.headless);
    }
  }

  private async fetchStatus(api: ApiClient): Promise<SetupStatus | null> {
    try {
      return await api.get<SetupStatus>('/repositories/github/setup/status');
    } catch {
      return null;
    }
  }

  private async runManifestFlow(
    api: ApiClient,
    apiUrl: string,
    headless: boolean,
  ): Promise<void> {
    console.log('');
    const defaultName = `flui-${os.hostname().split('.')[0]}`;
    const name = await promptInput({
      message: 'GitHub App name (must be unique across GitHub)',
      default: defaultName,
    });
    const publicApiUrl = await promptInput({
      message:
        'Flui public URL (must be reachable from github.com; OAuth callback, manifest redirect and webhook URL are derived from this)',
      default: apiUrl.replace(/\/api(\/v\d+)?$/, '').replace(/\/$/, ''),
      validate: (v) =>
        /^https?:\/\//.test(v) ? null : 'Must be an http(s) URL',
    });
    if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)/i.test(publicApiUrl)) {
      console.log(
        chalk.yellow(
          "  ! This URL points to localhost — GitHub won't reach the webhook (if enabled) nor complete the OAuth redirect from a different machine. Use a tunnel for development.",
        ),
      );
    }
    const webhooksEnabled = await confirmPrompt(
      'Enable webhooks for deploy-on-push?',
      false,
    );
    const publicApp = await confirmPrompt(
      'Allow installation on other accounts / organizations? (off = only the owner account can install)',
      false,
    );

    const spinner = ora('Requesting manifest…').start();
    let manifest: ManifestStartResponse;
    try {
      manifest = await api.post<ManifestStartResponse>(
        '/repositories/github/setup/github-app/manifest-start',
        { name, webhooksEnabled, publicApp, publicApiUrl },
      );
      spinner.succeed('Manifest ready');
    } catch (error: unknown) {
      spinner.fail('Failed to request manifest');
      this.printApiError(error);
      this.exit(1);
    }

    const port = await findFreeCallbackPort();
    const localUrl = `http://127.0.0.1:${port}/`;
    const server = this.startManifestSubmitServer(port, manifest);

    try {
      if (headless) {
        console.log('');
        console.log(
          chalk.dim('  Open this URL in a browser to create the App:'),
        );
        console.log(`  ${chalk.cyan(localUrl)}`);
      } else if (openInBrowser(localUrl)) {
        console.log(
          chalk.dim('\n  Opened browser. Confirm the App creation on GitHub…'),
        );
      } else {
        console.log(
          chalk.yellow(
            `\n  Could not open browser. Open this URL manually:\n  ${localUrl}\n`,
          ),
        );
      }

      const ok = await this.pollUntilConfigured(api);
      if (ok) {
        const fresh = await this.fetchStatus(api);
        console.log(
          chalk.green(
            `\n  ✔ GitHub App configured (${chalk.bold(fresh?.appSlug ?? '?')})\n`,
          ),
        );
        console.log(
          chalk.dim(
            `  Next: \`flui integration connect github\` to install on your account/org.\n`,
          ),
        );
      } else {
        console.log(
          chalk.red(
            '\n  ✖ Timed out waiting for the manifest callback. If the browser already redirected, check the dashboard.\n',
          ),
        );
        this.exit(1);
      }
    } finally {
      server.close();
    }
  }

  private startManifestSubmitServer(
    port: number,
    manifest: ManifestStartResponse,
  ): http.Server {
    const html = renderManifestSubmitPage(manifest);
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(port, '127.0.0.1');
    return server;
  }

  private async pollUntilConfigured(api: ApiClient): Promise<boolean> {
    const spinner = ora('Waiting for GitHub App credentials…').start();
    const start = Date.now();
    while (Date.now() - start < MANIFEST_POLL_TIMEOUT_MS) {
      const status = await this.fetchStatus(api);
      if (
        status?.configured &&
        status.authMethod === 'github_app' &&
        status.appSlug
      ) {
        spinner.succeed('GitHub App credentials persisted');
        return true;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, MANIFEST_POLL_INTERVAL_MS),
      );
    }
    spinner.fail('Manifest callback never arrived');
    return false;
  }

  private async runPatFlow(api: ApiClient, headless: boolean): Promise<void> {
    let chosen: Awaited<ReturnType<typeof promptForValidPat>>;
    try {
      chosen = await promptForValidPat(api, headless);
    } catch (error: unknown) {
      console.log(chalk.red('  Validation failed'));
      this.printApiError(error);
      this.exit(1);
    }
    if (!chosen) return;
    const { token, validation } = chosen;

    const spinner = ora('Saving token…').start();
    try {
      await api.post('/repositories/github/setup/pat');
      await api.post('/repositories/github/connect-pat', {
        personalAccessToken: token,
      });
      spinner.succeed('PAT saved');
    } catch (error: unknown) {
      spinner.fail('Failed to save PAT');
      this.printApiError(error);
      this.exit(1);
    }

    console.log(
      chalk.green(`\n  ✔ Connected as @${validation.login} via PAT.\n`),
    );
    console.log(
      chalk.dim(
        `  Next: \`flui repo list\` to see repositories or \`flui integration status github\` for details.\n`,
      ),
    );
  }

  private printApiError(error: unknown): void {
    if (error instanceof ApiError) {
      console.log(chalk.red(`  ${error.statusCode}: ${error.message}`));
      if (error.statusCode === 403) {
        console.log(
          chalk.yellow('  Admin privileges required for this operation.'),
        );
      }
    } else {
      console.log(chalk.red(`  ${(error as Error).message}`));
    }
  }
}

function renderManifestSubmitPage(manifest: ManifestStartResponse): string {
  const manifestJsonEscaped = JSON.stringify(manifest.manifestJson)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Creating Flui GitHub App…</title>
<style>body{font-family:system-ui,sans-serif;padding:48px;max-width:520px;margin:auto;color:#1f2937}h2{margin-bottom:8px}p{color:#6b7280}</style>
</head>
<body>
<h2>Redirecting to GitHub…</h2>
<p>This page will submit the GitHub App manifest. If nothing happens within a few seconds, ensure JavaScript is enabled and forms are not blocked.</p>
<form id="f" method="POST" action="${manifest.githubUrl}">
  <input type="hidden" name="manifest" value="${manifestJsonEscaped}" />
  <noscript><button type="submit">Continue to GitHub</button></noscript>
</form>
<script>document.getElementById('f').submit();</script>
</body>
</html>`;
}
