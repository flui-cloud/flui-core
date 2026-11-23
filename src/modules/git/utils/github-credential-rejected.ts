import { HttpException, HttpStatus } from '@nestjs/common';

export const GITHUB_TOKEN_INVALID = 'GITHUB_TOKEN_INVALID';

export type GithubCredential =
  | 'github-app'
  | 'github-account'
  | 'repository-token'
  | 'packages-token';

const REMEDY: Record<GithubCredential, string> = {
  'github-app':
    'GitHub rejected the token of the Flui GitHub App installation. Check that the app is still installed on this account or organization.',
  'github-account':
    'GitHub rejected the token of your connected GitHub account. Reconnect GitHub from the Repositories page.',
  'repository-token':
    'GitHub rejected the token saved when this repository was connected. Reconnect GitHub from the Repositories page.',
  'packages-token':
    'GitHub rejected the packages token Flui uses to read images. Replace it on the Repositories page.',
};

export interface GithubCredentialRejectedBody {
  statusCode: number;
  code: typeof GITHUB_TOKEN_INVALID;
  credential: GithubCredential;
  message: string;
}

export function isGithubCredentialRejection(error: unknown): boolean {
  const failure = error as
    | { status?: number; response?: { status?: number } }
    | undefined;
  return (failure?.status ?? failure?.response?.status) === 401;
}

const GIT_AUTH_FAILURE =
  /authentication failed|invalid username or password|could not read username|terminal prompts disabled/i;

/** A git clone over HTTPS refused because the token in the URL was not accepted. */
export function isGitAuthFailure(message: string | undefined): boolean {
  return !!message && GIT_AUTH_FAILURE.test(message);
}

/**
 * 424, not 401: the caller's own session is valid, and a 401 tells every
 * client to sign the person out.
 */
export function githubCredentialRejected(
  credential: GithubCredential,
): HttpException {
  const body: GithubCredentialRejectedBody = {
    statusCode: HttpStatus.FAILED_DEPENDENCY,
    code: GITHUB_TOKEN_INVALID,
    credential,
    message: REMEDY[credential],
  };
  return new HttpException(body, HttpStatus.FAILED_DEPENDENCY);
}
