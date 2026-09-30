import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from './api-client';
import { openInBrowser } from './browser-callback';
import { confirmPrompt, promptMaskedInput } from './prompts';

export interface PatValidationResult {
  valid: boolean;
  login?: string;
  scopes?: string[];
  missingScopes?: string[];
  error?:
    | 'empty_token'
    | 'invalid_token'
    | 'sso_required'
    | 'github_unreachable';
  message?: string;
}

export const PAT_SCOPES = [
  'repo',
  'workflow',
  'user:email',
  'admin:repo_hook',
  'write:packages',
  'read:packages',
  'delete:packages',
];

export const PAT_DEEP_LINK = `https://github.com/settings/tokens/new?scopes=${PAT_SCOPES.join(',')}&description=Flui+CLI`;

export function patErrorLabel(error?: string, message?: string): string {
  switch (error) {
    case 'invalid_token':
      return 'Invalid token — GitHub rejected it (401).';
    case 'sso_required':
      return 'Token needs SSO authorization for one of your orgs. Authorize on GitHub and try again.';
    case 'empty_token':
      return 'Token is empty.';
    case 'github_unreachable':
      return `Could not reach GitHub: ${message ?? 'unknown error'}`;
    default:
      return `Token validation failed${message ? `: ${message}` : '.'}`;
  }
}

export function validatePat(
  api: ApiClient,
  token: string,
): Promise<PatValidationResult> {
  return api.post<PatValidationResult>('/repositories/github/validate-pat', {
    token,
  });
}

/**
 * Points at the token page with the scopes Flui needs, then asks for the token
 * until GitHub accepts one. Null when the person gives up.
 */
export async function promptForValidPat(
  api: ApiClient,
  headless: boolean,
): Promise<{ token: string; validation: PatValidationResult } | null> {
  console.log('');
  console.log(
    chalk.dim(
      '  Create a classic PAT with the required scopes. The same token covers',
    ),
  );
  console.log(
    chalk.dim('  cloning private repos, webhooks, and GHCR container pulls.'),
  );
  console.log(`  ${chalk.cyan(PAT_DEEP_LINK)}`);
  if (!headless) openInBrowser(PAT_DEEP_LINK);
  console.log('');

  while (true) {
    const token = await promptMaskedInput('Paste your PAT');
    if (!token) {
      console.log(chalk.dim('  Cancelled.'));
      return null;
    }

    const spinner = ora('Validating token with GitHub…').start();
    const validation = await validatePat(api, token).finally(() =>
      spinner.stop(),
    );

    if (!validation.valid) {
      console.log(
        chalk.red(
          `  ✖ ${patErrorLabel(validation.error, validation.message)}`,
        ),
      );
      if (!(await confirmPrompt('Try another token?', true))) return null;
      continue;
    }

    printValidation(validation);
    if ((validation.missingScopes?.length ?? 0) > 0) {
      const cont = await confirmPrompt(
        'Save anyway? (webhooks/packages may not work)',
        false,
      );
      if (!cont) continue;
    }
    return { token, validation };
  }
}

export function printValidation(validation: PatValidationResult): void {
  console.log(
    chalk.green(
      `  ✔ Authenticated as @${validation.login}. Scopes: ${(validation.scopes ?? []).join(', ') || '<none>'}`,
    ),
  );
  if ((validation.missingScopes?.length ?? 0) > 0) {
    console.log(
      chalk.yellow(
        `  ! Missing scopes: ${validation.missingScopes!.join(', ')}`,
      ),
    );
  }
}
