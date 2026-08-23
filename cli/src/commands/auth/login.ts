import { Command, Flags } from '@oclif/core';
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import chalk from 'chalk';
import { ConfigStorage } from '../../lib/config-storage';
import { ProfileManager } from '../../lib/profile-manager';

// Must match FLUI_CLI_CALLBACK_PORTS in oidc-bootstrap.service.ts
const CALLBACK_PORTS = [8899, 8900, 8901, 8902, 8910];

// Native fetch doesn't respect Node's https.Agent, so disable TLS verification
// globally for this process. Required for self-signed / ACME-staging certs.
// TODO: remove once production TLS certs are in place.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const LOGIN_TIMEOUT_MS = 120_000;

interface AuthConfig {
  authMode: string;
  issuer?: string;
  cliClientId?: string;
}

interface TokenResponse {
  access_token: string;
  id_token?: string;
  token_type: string;
  expires_in?: number;
}

function base64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(
    crypto.createHash('sha256').update(verifier).digest(),
  );
  return { verifier, challenge };
}

function generateState(): string {
  return crypto.randomBytes(16).toString('hex');
}

function tryListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

async function findFreePort(ports: number[]): Promise<number> {
  for (const port of ports) {
    if (await tryListen(port)) return port;
  }
  throw new Error('No free port available in range');
}

function openBrowser(url: string): boolean {
  let cmd: string;
  let args: string[];
  if (process.platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else if (process.platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }
  try {
    execFile(cmd, args, () => undefined);
    return true;
  } catch {
    return false;
  }
}

function waitForCallback(
  port: number,
  expectedState: string,
): Promise<{ code: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error(`Login timed out after ${LOGIN_TIMEOUT_MS / 1000}s`));
    }, LOGIN_TIMEOUT_MS);

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end();
        return;
      }

      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      const html = (title: string, body: string) =>
        `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font-family:sans-serif;max-width:480px;margin:80px auto;text-align:center}</style></head><body>${body}</body></html>`;

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(
          html(
            'Login failed',
            `<h2>Login failed</h2><p>${error}</p><p>You can close this tab.</p>`,
          ),
        );
        clearTimeout(timer);
        server.close();
        reject(new Error(`Authorization error: ${error}`));
        return;
      }

      if (!code || state !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(
          html(
            'Invalid request',
            '<h2>Invalid callback</h2><p>State mismatch or missing code.</p>',
          ),
        );
        clearTimeout(timer);
        server.close();
        reject(new Error('Invalid callback: state mismatch or missing code'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        html(
          'Login successful',
          '<h2>Login successful</h2><p>Authentication complete. You can close this tab and return to the terminal.</p>',
        ),
      );
      clearTimeout(timer);
      server.close(() => resolve({ code }));
    });

    server.listen(port, '127.0.0.1');
  });
}

async function exchangeCode(
  issuer: string,
  clientId: string,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    client_id: clientId,
  });

  const res = await fetch(`${issuer}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(
      `Token exchange failed: ${data['error_description'] ?? data['error'] ?? res.status}`,
    );
  }
  return data as unknown as TokenResponse;
}

export default class AuthLogin extends Command {
  static readonly description =
    'Log in to Flui via OIDC (browser-based). Opens a browser for authentication, ' +
    'exchanges the code for tokens, generates a long-lived API key, and saves it to the active profile.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --headless',
    '<%= config.bin %> <%= command.id %> --profile staging',
  ];

  static readonly flags = {
    headless: Flags.boolean({
      description:
        'Print the authorization URL instead of opening a browser (useful in SSH sessions)',
      default: false,
    }),
    profile: Flags.string({
      description: 'Profile to save credentials into (default: active profile)',
    }),
    'key-name': Flags.string({
      description: 'Name for the generated API key',
      default: 'cli',
    }),
    prompt: Flags.string({
      description:
        "OIDC prompt. 'select_account' (default) shows the account picker so you confirm or switch user before minting an API key; 'login' forces re-authentication; '' reuses the current SSO session silently.",
      default: 'select_account',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AuthLogin);

    const profile = flags.profile ?? ProfileManager.getActiveProfile();
    const storage = new ConfigStorage(profile);
    const apiUrl = storage.getApiUrlOrThrow();

    this.log(chalk.dim(`Profile: ${profile}  API: ${apiUrl}`));

    // 1. Fetch auth config from API
    let config: AuthConfig;
    try {
      const res = await fetch(`${apiUrl}/auth/config`);
      if (!res.ok) {
        this.error(
          `GET ${apiUrl}/auth/config returned ${res.status}.\n` +
            `Make sure the Flui API is up to date and the endpoint is available.`,
          { exit: 1 },
        );
      }
      config = (await res.json()) as AuthConfig;
    } catch (e) {
      this.error(`Cannot reach API at ${apiUrl}: ${(e as Error).message}`, {
        exit: 1,
      });
    }

    if (config.authMode !== 'oidc') {
      this.error(
        `Auth mode is "${config.authMode ?? 'unknown'}". Browser login is only available in OIDC mode.\n` +
          `In local mode use your API key or JWT directly.`,
        { exit: 1 },
      );
    }

    if (!config.issuer || !config.cliClientId) {
      this.error(
        'OIDC CLI app not provisioned yet.\n' +
          'Ask your admin to call: POST /api/v1/auth/provision-cli-app',
        { exit: 1 },
      );
    }

    const { issuer, cliClientId } = config;

    // 2. PKCE + state
    const { verifier, challenge } = generatePkce();
    const state = generateState();
    const port = await findFreePort(CALLBACK_PORTS).catch(
      () => CALLBACK_PORTS[0],
    );
    const redirectUri = `http://localhost:${port}/callback`;

    const authUrl =
      `${issuer}/oauth/v2/authorize` +
      `?client_id=${encodeURIComponent(cliClientId)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&response_type=code` +
      `&scope=${encodeURIComponent('openid profile email')}` +
      (flags.prompt ? `&prompt=${encodeURIComponent(flags.prompt)}` : '') +
      `&code_challenge=${challenge}` +
      `&code_challenge_method=S256` +
      `&state=${state}`;

    // 3. Open browser or print URL
    this.log('');
    if (flags.headless) {
      this.log(chalk.bold('Open this URL in your browser:'));
      this.log(chalk.cyan(authUrl));
    } else {
      this.log(chalk.bold('Opening browser for login…'));
      this.log(
        chalk.dim(`If it doesn't open automatically, visit:\n${authUrl}`),
      );
      openBrowser(authUrl);
    }
    this.log('');
    this.log(
      chalk.dim(
        `Waiting for callback on http://localhost:${port}/callback (${LOGIN_TIMEOUT_MS / 1000}s timeout)…`,
      ),
    );

    // 4. Wait for redirect
    let code: string;
    try {
      ({ code } = await waitForCallback(port, state));
    } catch (e) {
      this.error((e as Error).message, { exit: 1 });
    }

    this.log(chalk.dim('Authorization code received. Exchanging for tokens…'));

    // 5. Exchange code → access_token
    let tokens: TokenResponse;
    try {
      tokens = await exchangeCode(
        issuer,
        cliClientId,
        code,
        verifier,
        redirectUri,
      );
    } catch (e) {
      this.error((e as Error).message, { exit: 1 });
    }

    this.log(chalk.dim('Token obtained. Generating API key…'));

    // 6. Generate long-lived Flui API key
    let apiKey: { id: string; name: string; key: string };
    try {
      const res = await fetch(`${apiUrl}/auth/api-keys`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          'Content-Type': 'application/json',
        },
        // Said out loud, and without asking: this key IS the person's session,
        // and full weight is what `flui login` means. The API stopped reading
        // an empty request as this, so omitting it here would
        // break the login rather than narrow it.
        body: JSON.stringify({ name: flags['key-name'], unscoped: true }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        throw new Error((body['message'] as string) ?? `HTTP ${res.status}`);
      }
      apiKey = body as typeof apiKey;
    } catch (e) {
      this.error(`Failed to generate API key: ${(e as Error).message}`, {
        exit: 1,
      });
    }

    // 7. Save to profile
    storage.setApiKey(apiKey.key);

    this.log('');
    this.log(chalk.green('✔ Login successful'));
    this.log(`  ${chalk.bold('Profile:')}  ${profile}`);
    this.log(`  ${chalk.bold('Key ID:')}   ${apiKey.id}`);
    this.log(`  ${chalk.bold('Key name:')} ${apiKey.name}`);
    this.log('');
    this.log(
      chalk.dim(
        'Your API key is saved. All CLI commands and scripts will use it automatically.',
      ),
    );
    this.log(
      chalk.dim(
        `To rotate: run 'flui login' again or 'flui auth generate-api-key'.`,
      ),
    );
  }
}
