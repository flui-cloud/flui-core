// The controller now reaches the mail stack, whose import graph pulls in
// ESM-only packages ts-jest cannot transform. The suite drives stubs, so none of
// them is ever constructed.
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { Request, Response } from 'express';
import {
  SandboxClaimController,
  loginUrl,
  resumeLink,
} from './sandbox-claim.controller';
import { SandboxReserveService } from './services/sandbox-reserve.service';
import { ApiKeyService } from '../auth/services/api-key.service';
import { ApiKeyStrategy } from '../auth/strategies/api-key.strategy';
import { SandboxConfig } from './sandbox.config';
import { SandboxTenantEntity } from './entities/sandbox-tenant.entity';
// Type-only: loading it would pull the mail stack in, and with it an ESM-only
// Kubernetes client that ts-jest cannot transform.
import type { SandboxResumeMailService } from './services/sandbox-resume-mail.service';

/**
 * Where a claimed guest is sent.
 *
 * A wrong value here is not a cosmetic bug: it is the only link the visitor is
 * given, and it is handed to them at the exact moment the product has to look
 * like it works.
 */
describe('the login URL a guest is handed', () => {
  it('assumes https for a bare hostname, which is what production passes', () => {
    expect(loginUrl('try.flui.cloud')).toBe('https://try.flui.cloud');
    expect(loginUrl('app.tidy-marmot.109-123-252-6.nip.io')).toBe(
      'https://app.tidy-marmot.109-123-252-6.nip.io',
    );
  });

  it('leaves a value that already carries a scheme alone', () => {
    // A local validation serves the dashboard over plain HTTP; prepending
    // https there produces a link that cannot connect.
    expect(loginUrl('http://localhost:4200')).toBe('http://localhost:4200');
    expect(loginUrl('https://try.flui.cloud')).toBe('https://try.flui.cloud');
  });
});

/**
 * Coming back must not cost a tenancy.
 *
 * The reserve is finite and the per-address limit counts claims, so a second
 * click on the entrance used to spend one of each — the brake against abuse
 * closing on the visitor who simply reopened the page.
 */
describe('claiming with a session already in hand', () => {
  const tenant = {
    id: 't-1',
    namespace: 'user-guest-abc',
    userId: 'guest-1',
    expiresAt: new Date(Date.now() + 3_600_000),
  } as SandboxTenantEntity;

  const config = {
    enabled: true,
    acceptingClaims: true,
    ttlHours: 24,
    baseDomain: 'try.flui.cloud',
  } as SandboxConfig;

  const req = (cookie?: string) =>
    ({
      headers: cookie ? { cookie: `flui_session=${cookie}` } : {},
    }) as Request;
  const res = () => ({ cookie: jest.fn() }) as unknown as Response;

  const build = (overrides: {
    validate?: jest.Mock;
    findActiveForUser?: jest.Mock;
    claim?: jest.Mock;
  }) => {
    const reserve = {
      findActiveForUser: overrides.findActiveForUser ?? jest.fn(),
      claim:
        overrides.claim ??
        jest.fn().mockResolvedValue({ tenant, expiresAt: tenant.expiresAt }),
    } as unknown as SandboxReserveService;
    const apiKeys = {
      generateApiKey: jest.fn().mockResolvedValue({ plaintext: 'flui_new' }),
    } as unknown as ApiKeyService;
    const strategy = {
      validate: overrides.validate ?? jest.fn(),
    } as unknown as ApiKeyStrategy;
    const resumeMail = {
      sendResumeLink: jest.fn().mockResolvedValue({ sent: true }),
    } as unknown as SandboxResumeMailService;
    return {
      controller: new SandboxClaimController(
        reserve,
        apiKeys,
        strategy,
        resumeMail,
        config,
      ),
      resumeMail,
      reserve,
      apiKeys,
    };
  };

  it('gives back the tenancy the caller already holds, taking none from the reserve', async () => {
    const { controller, reserve, apiKeys } = build({
      validate: jest.fn().mockResolvedValue({ userId: 'guest-1' }),
      findActiveForUser: jest.fn().mockResolvedValue(tenant),
    });

    const out = await controller.claim(req('flui_existing'), res());

    expect(out.resumed).toBe(true);
    expect(out.apiKey).toBeUndefined();
    expect(out.loginUrl).toBe('https://try.flui.cloud');
    expect(reserve.claim).not.toHaveBeenCalled();
    expect(apiKeys.generateApiKey).not.toHaveBeenCalled();
  });

  it('assigns a new tenancy when there is no cookie', async () => {
    const { controller, reserve } = build({});
    const out = await controller.claim(req(), res());

    expect(out.resumed).toBe(false);
    expect(out.apiKey).toBe('flui_new');
    expect(reserve.claim).toHaveBeenCalled();
  });

  it.each([
    [
      'a credential that no longer validates',
      { validate: jest.fn().mockRejectedValue(new Error('revoked')) },
    ],
    [
      'a valid credential whose tenancy is gone',
      {
        validate: jest.fn().mockResolvedValue({ userId: 'guest-1' }),
        findActiveForUser: jest.fn().mockResolvedValue(null),
      },
    ],
  ])('falls through to a fresh tenancy for %s', async (_label, overrides) => {
    const { controller, reserve } = build(overrides);
    const out = await controller.claim(req('flui_stale'), res());

    expect(out.resumed).toBe(false);
    expect(reserve.claim).toHaveBeenCalled();
  });

  it('never puts the namespace or the synthetic address in a public response', async () => {
    const { controller } = build({
      validate: jest.fn().mockResolvedValue({ userId: 'guest-1' }),
      findActiveForUser: jest.fn().mockResolvedValue(tenant),
    });
    const out = await controller.claim(req('flui_existing'), res());

    expect(JSON.stringify(out)).not.toContain('user-guest-abc');
    expect(out).not.toHaveProperty('namespace');
    expect(out).not.toHaveProperty('email');
  });
});

/**
 * The way back in.
 *
 * The link is worth exactly what the browser that asked for it already holds —
 * a credential for one throwaway tenancy — and it dies with that tenancy. What
 * matters here is that it never points anywhere else, and that a bad one says
 * nothing about why.
 */
describe('the resume link', () => {
  const OLD = process.env.API_BASE_URL;
  afterEach(() => {
    if (OLD === undefined) delete process.env.API_BASE_URL;
    else process.env.API_BASE_URL = OLD;
  });

  it('points at the API, which is the only thing that can set the cookie', () => {
    process.env.API_BASE_URL = 'https://api.try.flui.cloud';
    expect(resumeLink('try.flui.cloud', 'flui_abc')).toBe(
      'https://api.try.flui.cloud/api/v1/sandbox/resume?token=flui_abc',
    );
  });

  it('falls back to the dashboard origin when no API base is configured', () => {
    delete process.env.API_BASE_URL;
    expect(resumeLink('http://localhost:4200', 'flui_abc')).toBe(
      'http://localhost:4200/api/v1/sandbox/resume?token=flui_abc',
    );
  });

  it('escapes the token rather than pasting it into the query', () => {
    delete process.env.API_BASE_URL;
    expect(resumeLink('http://localhost:4200', 'a b&c=d')).toContain(
      'token=a%20b%26c%3Dd',
    );
  });
});
