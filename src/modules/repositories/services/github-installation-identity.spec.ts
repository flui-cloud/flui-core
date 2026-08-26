// The import graph reaches the ESM-only Octokit packages; nothing here builds a
// real client.
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { getMetadataArgsStorage } from 'typeorm';
import { GitHubAppInstallationEntity } from '../entities/github-app-installation.entity';
import { GitHubAppService } from './github-app.service';

const MODULE_ROOT = join(__dirname, '..');

const sourceFiles = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts'))
        out.push(full);
    }
  };
  walk(MODULE_ROOT);
  return out;
};

const column = (propertyName: string) =>
  getMetadataArgsStorage().columns.find(
    (c) =>
      c.target === GitHubAppInstallationEntity &&
      c.propertyName === propertyName,
  );

const payload = (over: Record<string, unknown> = {}) => ({
  installation: {
    id: 99,
    account: { login: 'Acme', type: 'Organization' },
    repository_selection: 'all',
  },
  sender: { login: 'octo-admin' },
  ...over,
});

const build = () => {
  const saved: Partial<GitHubAppInstallationEntity>[] = [];
  const service = new GitHubAppService(
    {} as never,
    {} as never,
    {
      findOne: async () => null,
      create: (row: Partial<GitHubAppInstallationEntity>) => row,
      save: async (row: Partial<GitHubAppInstallationEntity>) => {
        saved.push(row);
        return row;
      },
    } as never,
    {} as never,
  );
  return { service, saved };
};

/**
 * `user_id` carried two kinds of value: a Flui UUID from the connect flow, and
 * a GitHub login from the webhook. A column with two meanings invites the next
 * reader to filter on it, and that filter would silently drop every
 * installation the webhook recorded.
 */
describe('a GitHub App installation may have no Flui user yet', () => {
  describe('the column', () => {
    it('admits that nobody has claimed the installation', () => {
      expect(column('userId')?.options.nullable).toBe(true);
    });

    it('gives the GitHub login a place of its own', () => {
      expect(column('installedByLogin')?.options.nullable).toBe(true);
      expect(column('installedByLogin')?.options.name).toBe(
        'installed_by_login',
      );
    });
  });

  describe('what gets written', () => {
    it('stores no user when none was given, and keeps the login as a login', async () => {
      const built = build();

      await built.service.handleInstallationCreated(payload());

      expect(built.saved[0].userId).toBeNull();
      expect(built.saved[0].installedByLogin).toBe('octo-admin');
      expect(built.saved[0].accountLogin).toBe('acme');
    });

    it('stores the Flui user when the discovery flow supplies one', async () => {
      const built = build();

      await built.service.handleInstallationCreated(
        payload(),
        '11111111-2222-3333-4444-555555555555',
      );

      expect(built.saved[0].userId).toBe(
        '11111111-2222-3333-4444-555555555555',
      );
    });

    it('records nothing when the payload has no sender', async () => {
      const built = build();

      await built.service.handleInstallationCreated(payload({ sender: null }));

      expect(built.saved[0].installedByLogin).toBeNull();
    });
  });

  it('is never used to select an installation', () => {
    // Counting your own rows is a lower bound and cannot widen access.
    // Selecting by it would be an authorization, and this column cannot bear
    // one — reachability is GitHub's answer, not this row's.
    const methods = new Set<string>();
    for (const file of sourceFiles()) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(
        /(\w+)\.(\w+)\(\s*\{\s*where:\s*\{[^}]*\buserId\b/g,
      )) {
        if (!/installation/i.test(match[1])) continue;
        methods.add(`${relative(MODULE_ROOT, file)}#${match[2]}`);
      }
    }
    expect([...methods].sort()).toEqual([
      'services/github-app-user-auth.service.ts#count',
    ]);
  });
});
