jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));

import { SandboxController } from './sandbox.controller';
import { loadSandboxConfig } from './sandbox.config';

describe('GET /sandbox/limits and the visitor', () => {
  const limits = new SandboxController(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    loadSandboxConfig({}),
  ).limits();

  const rule = (route: string) =>
    limits.allowed.find((r) => r.routes.includes(route));

  it('says which writes a visitor may make', () => {
    expect(rule('POST /auth/api-keys')?.visitor).toBe(true);
    expect(rule('POST /mcp')?.visitor).toBe(true);
    expect(rule('POST /sandbox/keep')?.visitor).toBe(false);
  });

  it('answers the flag on every rule', () => {
    for (const r of limits.allowed) expect(typeof r.visitor).toBe('boolean');
  });
});
