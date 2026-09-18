jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: jest.fn() }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));

import { WebhooksService } from './webhooks.service';

/**
 * F-051 and the runtime half of F-022, September 2026 register.
 *
 * The route is `@Public()`: this comparison is the whole of its authentication.
 * It used to be a single `app?.webhookToken !== token`, which is fail-OPEN — a
 * request with no `X-Flui-Token` header naming an application id that does not
 * exist compared `undefined` with `undefined`, found them equal, and was let in.
 */

const TOKEN = 'b6f0a2de-1f0a-4a7a-9a5f-0f2c5a9d1e77';

function build(app: { id: string; webhookToken: string | null } | null) {
  const applicationRepository = {
    findOne: jest.fn(async () => app),
    update: jest.fn(async () => undefined),
  };
  const eventsGateway = new Proxy({}, { get: () => jest.fn() }) as Record<
    string,
    jest.Mock
  >;
  return new WebhooksService(
    applicationRepository as never,
    {} as never,
    {} as never,
    eventsGateway as never,
    {} as never,
  );
}

const call = (
  service: WebhooksService,
  token: string | undefined,
): Promise<unknown> =>
  service.handleGitHubActionsWebhook(
    token as string,
    {
      appId: 'a1',
      status: 'failed',
    } as never,
  );

describe('the build-completion webhook decides who is calling', () => {
  it.each([
    ['no application and no header', null, undefined],
    ['no application and a header', null, TOKEN],
    [
      'an application that was never armed, and no header',
      'unarmed',
      undefined,
    ],
    ['an unarmed application and a header', 'unarmed', TOKEN],
    ['an armed application and no header', 'armed', undefined],
    ['an armed application and the wrong token', 'armed', 'not-the-token'],
    [
      'an armed application and a token of the right length but wrong value',
      'armed',
      TOKEN.replace(/.$/, '8'),
    ],
    ['an armed application and an empty header', 'armed', ''],
  ])('refuses %s', async (_label, appKind, token) => {
    const app =
      appKind === null
        ? null
        : {
            id: 'a1',
            webhookToken: appKind === 'armed' ? TOKEN : null,
          };

    await expect(call(build(app), token)).rejects.toThrow(
      'Invalid webhook token',
    );
  });

  it('accepts the token the application was armed with', async () => {
    const service = build({ id: 'a1', webhookToken: TOKEN });

    await expect(call(service, TOKEN)).resolves.toEqual({ received: true });
  });

  it('answers an unknown application exactly as it answers a wrong token', async () => {
    const unknown = await call(build(null), TOKEN).catch(
      (e: Error) => e.message,
    );
    const wrong = await call(
      build({ id: 'a1', webhookToken: TOKEN }),
      'not-the-token',
    ).catch((e: Error) => e.message);

    expect(unknown).toBe(wrong);
  });
});
