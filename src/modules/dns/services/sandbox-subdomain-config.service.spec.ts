import { SandboxSubdomainConfigService } from './sandbox-subdomain-config.service';

const withEnv = (env: Record<string, string | undefined>) =>
  new SandboxSubdomainConfigService({
    get: (key: string) => env[key],
  } as never);

describe('SandboxSubdomainConfigService', () => {
  /**
   * The guarantee the whole feature is built behind: an installation that says
   * nothing behaves exactly as it does today.
   */
  it('is off unless the environment says true', () => {
    expect(withEnv({}).isEnabled()).toBe(false);
    expect(withEnv({ FLUI_SANDBOX_SUBDOMAIN: 'yes' }).isEnabled()).toBe(false);
    expect(withEnv({ FLUI_SANDBOX_SUBDOMAIN: 'true' }).isEnabled()).toBe(true);
  });

  it('calls the subdomain demo unless the installation names another', () => {
    expect(withEnv({}).label()).toBe('demo');
    expect(withEnv({ FLUI_SANDBOX_SUBDOMAIN_LABEL: '  ' }).label()).toBe(
      'demo',
    );
    expect(withEnv({ FLUI_SANDBOX_SUBDOMAIN_LABEL: 'try' }).label()).toBe(
      'try',
    );
  });

  /**
   * The label describes one cluster's applications. Without knowing which, the
   * record would be published pointing at whichever cluster reconciled last.
   */
  it('belongs to no cluster until one is named', () => {
    expect(withEnv({ FLUI_SANDBOX_SUBDOMAIN: 'true' }).ownsCluster('c-1')).toBe(
      false,
    );
    expect(
      withEnv({
        FLUI_SANDBOX_SUBDOMAIN: 'true',
        SANDBOX_CLUSTER_ID: 'c-1',
      }).ownsCluster('c-1'),
    ).toBe(true);
    expect(
      withEnv({
        FLUI_SANDBOX_SUBDOMAIN: 'true',
        SANDBOX_CLUSTER_ID: 'c-1',
      }).ownsCluster('c-2'),
    ).toBe(false);
  });

  it('belongs to no cluster while the feature is off', () => {
    expect(withEnv({ SANDBOX_CLUSTER_ID: 'c-1' }).ownsCluster('c-1')).toBe(
      false,
    );
  });
});
