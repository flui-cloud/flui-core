import { MaskedReader, readSecret } from './secret-input';
import { stdinRequested } from './stdin-value';
import type { SignInProvider } from './sandbox-client';

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
    'Homepage URL: the demo dashboard. Authorization callback URL: the one below.',
  ],
  google: [
    'Create an OAuth client ID of type "Web application" at https://console.cloud.google.com/apis/credentials.',
    'Authorized redirect URI: the one below.',
  ],
};

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
