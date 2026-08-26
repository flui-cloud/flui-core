// The import graph reaches the ESM-only Octokit packages; nothing here builds a
// real client.
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GitHubAppWebhookService } from './github-app-webhook.service';

const payload = {
  installation: {
    id: 99,
    account: { login: 'Acme', type: 'Organization' },
    repository_selection: 'all',
  },
  sender: { login: 'octo-admin' },
};

const build = () => {
  const calls: unknown[][] = [];
  const service = new GitHubAppWebhookService(
    {} as never,
    {
      handleInstallationCreated: async (...args: unknown[]) => {
        calls.push(args);
        return {} as never;
      },
    } as never,
  );
  return { service, calls };
};

/**
 * The webhook knows a GitHub login, not a Flui user. It used to write that
 * login — or the literal 'unknown' — into `user_id`, the column the connect
 * flow fills with a Flui UUID, leaving one column with two kinds of value.
 */
describe('installation.created records no invented identity', () => {
  it('hands the handler the payload and nothing else', async () => {
    const built = build();

    await built.service.handleEvent('installation', 'created', payload);

    expect(built.calls).toHaveLength(1);
    expect(built.calls[0]).toEqual([payload]);
  });

  it('never passes the sender login or a placeholder as the user', async () => {
    const built = build();

    await built.service.handleEvent('installation', 'created', payload);

    const extra = built.calls[0].slice(1);
    expect(extra).not.toContain('octo-admin');
    expect(extra).not.toContain('unknown');
  });

  it('carries no user argument in the source at all', () => {
    // A source pin: passing anything as the second argument here is the defect,
    // whatever value it happens to be.
    const source = readFileSync(
      join(__dirname, 'github-app-webhook.service.ts'),
      'utf8',
    );
    expect(source).toMatch(/handleInstallationCreated\(\s*payload,?\s*\)/);
    expect(source).not.toMatch(
      /handleInstallationCreated\(\s*payload\s*,\s*[^)\s]/,
    );
    expect(source).not.toContain("'unknown'");
  });
});
