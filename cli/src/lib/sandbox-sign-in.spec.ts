import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SignInCredentialsError,
  callbackLines,
  collectSignInCredentials,
  signInRoot,
} from './sandbox-sign-in';

jest.mock('./stdin-value', () => ({
  stdinRequested: jest.fn(() => false),
  stdinValue: jest.fn(() => ''),
}));

import { stdinRequested, stdinValue } from './stdin-value';

const requested = stdinRequested as jest.MockedFunction<typeof stdinRequested>;
const piped = stdinValue as jest.MockedFunction<typeof stdinValue>;

describe('collecting sign-in credentials', () => {
  beforeEach(() => {
    requested.mockReturnValue(false);
    piped.mockReturnValue('');
  });

  it('asks for the secret at a masked prompt, never through the visible one', async () => {
    const askClientId = jest.fn(async () => 'typed-id');
    const readMasked = jest.fn(async () => '  s3cret  ');

    await expect(
      collectSignInCredentials('github', { askClientId, readMasked }),
    ).resolves.toEqual({ clientId: 'typed-id', clientSecret: 's3cret' });
    expect(readMasked).toHaveBeenCalledWith('GitHub client secret');
    expect(askClientId).toHaveBeenCalledWith('GitHub client ID');
  });

  it('takes the client ID from the flag without asking for it', async () => {
    const askClientId = jest.fn(async () => 'unused');

    await expect(
      collectSignInCredentials('google', {
        clientId: 'g-id',
        askClientId,
        readMasked: async () => 'secret',
      }),
    ).resolves.toEqual({ clientId: 'g-id', clientSecret: 'secret' });
    expect(askClientId).not.toHaveBeenCalled();
  });

  it('reads the secret from standard input with --stdin, without prompting', async () => {
    requested.mockReturnValue(true);
    piped.mockReturnValue('from-pipe\n');
    const readMasked = jest.fn(async () => 'typed');

    await expect(
      collectSignInCredentials('github', {
        clientId: 'id',
        askClientId: async () => 'unused',
        readMasked,
      }),
    ).resolves.toEqual({ clientId: 'id', clientSecret: 'from-pipe' });
    expect(readMasked).not.toHaveBeenCalled();
  });

  it('refuses --stdin without --client-id, since the pipe holds the secret', async () => {
    requested.mockReturnValue(true);
    piped.mockReturnValue('from-pipe');

    await expect(
      collectSignInCredentials('github', {
        askClientId: async () => 'typed',
        readMasked: async () => 'typed',
      }),
    ).rejects.toBeInstanceOf(SignInCredentialsError);
  });

  it('connects nothing when the secret is empty', async () => {
    await expect(
      collectSignInCredentials('github', {
        clientId: 'id',
        askClientId: async () => 'unused',
        readMasked: async () => '   ',
      }),
    ).rejects.toThrow('No client secret was supplied');
  });

  it('declares no flag that could carry the secret', () => {
    const source = readFileSync(
      join(__dirname, '..', 'commands', 'sandbox', 'sign-in', 'connect.ts'),
      'utf8',
    );
    const flags = source.slice(
      source.indexOf('static readonly flags'),
      source.indexOf('async run()'),
    );
    expect(flags).not.toMatch(/secret['"]?\s*:\s*Flags/i);
    expect(flags).toContain("'client-id': Flags.string");
    expect(flags).toContain('stdin: Flags.boolean');
  });
});

describe('the addresses to register at GitHub and Google', () => {
  const view = {
    callbackUrl:
      'https://auth.demo.example.com/ui/login/login/externalidp/callback',
    intentCallbackUrl: 'https://auth.demo.example.com/idps/callback',
  };

  it('gives GitHub the sign-in root, which covers both callbacks', () => {
    expect(callbackLines('github', view)).toEqual([
      ['Callback URL', 'https://auth.demo.example.com/'],
    ]);
  });

  it('gives Google both redirect URIs', () => {
    expect(callbackLines('google', view)).toEqual([
      ['Redirect URI', view.callbackUrl],
      ['Redirect URI', view.intentCallbackUrl],
    ]);
  });

  it('lists both providers when none is named', () => {
    expect(callbackLines(null, view).map(([label]) => label)).toEqual([
      'GitHub callback',
      'Google redirect',
      'Google redirect',
    ]);
  });

  it('says nothing without a sign-in address', () => {
    expect(
      callbackLines('github', { callbackUrl: null, intentCallbackUrl: null }),
    ).toEqual([]);
  });

  it('falls back to the origin for an unexpected callback', () => {
    expect(signInRoot('https://auth.example.com/other/path')).toBe(
      'https://auth.example.com/',
    );
  });
});
