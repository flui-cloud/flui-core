jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: jest.fn() }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));

import { BootstrapSeeder } from './bootstrap.seeder';

/**
 * F-028 of the September 2026 register: the seeder printed the first ten
 * characters of `FLUI_CLI_API_KEY` at startup.
 *
 * The summary is worth having — "is this installation configured" is the first
 * question anybody asks of a boot log — but the answer is presence, never a
 * prefix. Ten characters of a credential in log aggregation is a credential in
 * log aggregation, narrowed.
 */

const SECRETS = {
  FLUI_CLI_API_KEY: 'flui_11111111-2222-3333-4444-555555555555',
  FLUI_CA_PUBLIC_KEY: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAASecretLooking',
  PROVIDER_HETZNER_API_KEY: 'hetzner-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  PROVIDER_SCALEWAY_ACCESS_KEY: 'SCWXXXXXXXXXXXXXXXXX',
  PROVIDER_SCALEWAY_SECRET_KEY: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
  K3S_TOKEN: 'K10aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa::server:secret',
  KUBECONFIG_CONTENT:
    'apiVersion: v1\nclusters:\n- cluster:\n    token: hidden',
};

describe('the environment summary written at boot', () => {
  let logged: string[];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    logged = [];
    saved = {};
    for (const [name, value] of Object.entries(SECRETS)) {
      saved[name] = process.env[name];
      process.env[name] = value;
    }
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const summarise = () => {
    const seeder = Object.create(BootstrapSeeder.prototype) as BootstrapSeeder;
    Object.assign(seeder, {
      logger: {
        log: (...a: unknown[]) => logged.push(a.map(String).join(' ')),
        warn: (...a: unknown[]) => logged.push(a.map(String).join(' ')),
        error: (...a: unknown[]) => logged.push(a.map(String).join(' ')),
        debug: (...a: unknown[]) => logged.push(a.map(String).join(' ')),
      },
    });
    (seeder as unknown as { logEnvSummary: () => void }).logEnvSummary();
    return logged.join('\n');
  };

  it('says whether each credential is set, and nothing more', () => {
    const output = summarise();

    expect(output).toContain('FLUI_CLI_API_KEY');
    expect(output).toContain('(present)');
    for (const [name, value] of Object.entries(SECRETS)) {
      expect(output).not.toContain(value);
      // No prefix either: a fragment is the shape this finding actually took.
      expect(output).not.toContain(value.slice(0, 10));
      expect(name).toBeTruthy();
    }
  });

  it('still distinguishes a missing credential from a set one', () => {
    delete process.env.PROVIDER_HETZNER_API_KEY;

    const output = summarise();

    expect(output).toMatch(/PROVIDER_HETZNER_API_KEY[^\n]*\(missing\)/);
  });
});
