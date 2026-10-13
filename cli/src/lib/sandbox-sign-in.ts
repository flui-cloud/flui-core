import { MaskedReader, readSecret } from './secret-input';
import { stdinRequested } from './stdin-value';
import type { SignInProvider, SignInProviders } from './sandbox-client';

export const SIGN_IN_PROVIDERS: readonly SignInProvider[] = [
  'github',
  'google',
];

export const SIGN_IN_PROVIDER_NAMES: Record<SignInProvider, string> = {
  github: 'GitHub',
  google: 'Google',
};

/** Where the person creates the OAuth app whose credentials they are about to hand over. */
export const OAUTH_APP_HELP: Record<SignInProvider, string[]> = {
  github: [
    'Create an OAuth app under your organisation at https://github.com/organizations/<org>/settings/applications',
    '(or under your own account at https://github.com/settings/developers).',
    'Homepage URL: the demo dashboard. Authorization callback URL: the sign-in address below.',
  ],
  google: [
    'Create an OAuth client ID of type "Web application" at https://console.cloud.google.com/apis/credentials.',
    'Authorized redirect URIs: both addresses below.',
  ],
};

const SIGN_IN_CALLBACK_PATH = '/ui/login/login/externalidp/callback';

/** The sign-in address itself, which GitHub accepts for every callback under it. */
export function signInRoot(callbackUrl: string): string {
  const base = callbackUrl.endsWith(SIGN_IN_CALLBACK_PATH)
    ? callbackUrl.slice(0, -SIGN_IN_CALLBACK_PATH.length)
    : new URL(callbackUrl).origin;
  return `${base}/`;
}

/**
 * What to register at GitHub or Google. Signing in and a visitor turning its
 * visit into an account come back to two different addresses: GitHub takes
 * any address under its callback, so the sign-in root covers both; Google
 * wants each one listed.
 */
export function callbackLines(
  provider: SignInProvider | null,
  view: Pick<SignInProviders, 'callbackUrl' | 'intentCallbackUrl'>,
): Array<[label: string, value: string]> {
  if (!view.callbackUrl) return [];
  const google: Array<[string, string]> = [['Redirect URI', view.callbackUrl]];
  if (view.intentCallbackUrl) {
    google.push(['Redirect URI', view.intentCallbackUrl]);
  }
  const github: Array<[string, string]> = [
    ['Callback URL', signInRoot(view.callbackUrl)],
  ];
  if (provider === 'github') return github;
  if (provider === 'google') return google;
  return [
    ['GitHub callback', github[0][1]],
    ...google.map(([, url]): [string, string] => ['Google redirect', url]),
  ];
}

export class SignInCredentialsError extends Error {}

/**
 * The client ID and secret for a sign-in provider, from the person.
 *
 * The secret never comes from a flag: it is read from standard input with
 * `--stdin`, or asked for at a prompt that does not echo. The client ID is
 * public and may be passed as a flag or typed in.
 */
export async function collectSignInCredentials(
  provider: SignInProvider,
  opts: {
    clientId?: string;
    askClientId: (label: string) => Promise<string>;
    readMasked?: MaskedReader;
  },
): Promise<{ clientId: string; clientSecret: string }> {
  const name = SIGN_IN_PROVIDER_NAMES[provider];
  let clientId = opts.clientId?.trim() ?? '';
  if (!clientId) {
    if (stdinRequested()) {
      throw new SignInCredentialsError(
        'With --stdin, standard input carries the client secret: pass the client ID with --client-id.',
      );
    }
    clientId = (await opts.askClientId(`${name} client ID`)).trim();
  }
  if (!clientId) {
    throw new SignInCredentialsError(
      'No client ID was supplied, so nothing was connected.',
    );
  }

  const clientSecret = await readSecret(
    { label: `${name} client secret`, fromStdin: true },
    opts.readMasked,
  );
  if (!clientSecret) {
    throw new SignInCredentialsError(
      'No client secret was supplied, so nothing was connected.',
    );
  }
  return { clientId, clientSecret };
}
