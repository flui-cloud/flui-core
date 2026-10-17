import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// The test's HOME is only visible inside the sandbox; the real homedir() reads
// the process environment and would land on the developer's own profiles.
function mockSandboxHome() {
  const os = jest.requireActual('node:os');
  return { ...os, homedir: () => process.env.HOME };
}
jest.mock('node:os', () => mockSandboxHome());
jest.mock('os', () => mockSandboxHome());

jest.mock('chalk', () => {
  const same = (text: string) => text;
  const chalk: any = new Proxy(same, { get: () => chalk });
  return { __esModule: true, default: chalk };
});

jest.mock('ora', () => {
  const spinner: any = new Proxy(() => spinner, { get: () => () => spinner });
  return { __esModule: true, default: () => spinner };
});

jest.mock('../../lib/stdin-value', () => ({
  stdinRequested: () => true,
  stdinValue: () => 'not-a-real-token',
}));

jest.mock('../../lib/nest-app', () => ({
  getNestApp: jest.fn(() => {
    throw new Error('env create reached the provider');
  }),
  closeNestApp: jest.fn(),
}));

const CLI_ROOT = resolve(__dirname, '../../../..');

/**
 * The run a managed provisioner makes: a HOME that exists for this run only,
 * and the profile key in FLUI_PROFILE_KEY instead of a vault.
 *
 * The region probe is how the provisioner learns which regions the CLI will
 * accept, so the refusal has to be about the region. Refused for a missing
 * vault instead, the probe reads as a CLI that will not answer, and the
 * provisioner refuses to start.
 */
describe('env create with a caller-supplied profile key and no vault', () => {
  const saved = { home: process.env.HOME, key: process.env.FLUI_PROFILE_KEY };
  let home: string;

  beforeEach(() => {
    jest.resetModules();
    home = mkdtempSync(join(tmpdir(), 'flui-supplied-key-'));
    process.env.HOME = home;
    process.env.FLUI_PROFILE_KEY = randomBytes(32).toString('base64');
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
    if (saved.home === undefined) delete process.env.HOME;
    else process.env.HOME = saved.home;
    if (saved.key === undefined) delete process.env.FLUI_PROFILE_KEY;
    else process.env.FLUI_PROFILE_KEY = saved.key;
  });

  async function asTheRunnerDoes(): Promise<{
    create: (argv: string[]) => Promise<unknown>;
  }> {
    const { ProfileManager } = await import('../../lib/profile-manager');
    expect(ProfileManager.BASE_DIR).toBe(join(home, '.flui'));

    const { openProfileKey } = await import('../../lib/vault/open-profile-key');
    const { default: ConfigSet } = await import('../config/set');
    const { default: EnvCreate } = await import('./create');

    await openProfileKey();
    await ConfigSet.run(['hetzner', '--stdin'], CLI_ROOT);

    return {
      create: (argv) =>
        EnvCreate.run(
          [
            '--provider',
            'hetzner',
            '--non-interactive',
            '--firewall-ip',
            '192.0.2.10',
            '--ssh-mode',
            'ephemeral-key',
            '--wait',
            ...argv,
          ],
          CLI_ROOT,
        ),
    };
  }

  it('refuses an unknown region by listing the allowed ones, not for a missing vault', async () => {
    const { create } = await asTheRunnerDoes();

    const refusal = await create(['--region', 'flui-preflight-no-such-region'])
      .then(() => null)
      .catch((error: Error) => error);

    expect(refusal?.message).not.toMatch(/vault/i);
    expect(refusal?.message).toMatch(
      /Region 'flui-preflight-no-such-region' is not supported for provider 'hetzner'\. Allowed: nbg1, fsn1, hel1/,
    );
  });

  it('gets past the vault check for a real region and creates no vault', async () => {
    const { create } = await asTheRunnerDoes();

    await create(['--region', 'nbg1']).catch(() => undefined);

    const { getNestApp } = await import('../../lib/nest-app');
    expect(getNestApp).toHaveBeenCalled();
    expect(existsSync(join(home, '.flui', 'vault.json'))).toBe(false);
  });
});
