import { UnauthorizedException } from '@nestjs/common';
import type { Socket } from 'socket.io';
import { WsAuthService } from './ws-auth.service';

/**
 * F-025 of the September 2026 register, confirmed live: the handshake accepted
 * a bearer from `?token=`, so the credential was written into every proxy and
 * access log between the browser and the API and kept there for the log's
 * retention.
 *
 * The three remaining sources are asserted alongside the refused one, because
 * what makes removing the fourth safe is that they exist — every first-party
 * client sends `auth.token`.
 */

const KEY = 'flui_a-key-the-api-key-strategy-would-accept';

function build() {
  const apiKeyStrategy = {
    validate: jest.fn(async (presented: string) => ({
      userId: 'u1',
      presented,
    })),
  };
  const service = new WsAuthService(
    { get: () => undefined } as never,
    {} as never,
    apiKeyStrategy as never,
    {} as never,
  );
  return { service, apiKeyStrategy };
}

const socket = (handshake: Record<string, unknown>): Socket =>
  ({ handshake: { headers: {}, ...handshake } }) as unknown as Socket;

describe('where a websocket credential may come from', () => {
  it('is not the query string', async () => {
    const { service, apiKeyStrategy } = build();

    await expect(
      service.authenticate(socket({ query: { token: KEY } })),
    ).rejects.toThrow(UnauthorizedException);
    expect(apiKeyStrategy.validate).not.toHaveBeenCalled();
  });

  it('is not the query string even alongside an unrelated query parameter', async () => {
    const { service } = build();

    await expect(
      service.authenticate(
        socket({ query: { tenantId: 'default', token: KEY } }),
      ),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('is the handshake auth payload', async () => {
    const { service, apiKeyStrategy } = build();

    await service.authenticate(socket({ auth: { token: KEY } }));

    expect(apiKeyStrategy.validate).toHaveBeenCalledWith(KEY);
  });

  it('is the authorization header', async () => {
    const { service, apiKeyStrategy } = build();

    await service.authenticate(
      socket({ headers: { authorization: `Bearer ${KEY}` } }),
    );

    expect(apiKeyStrategy.validate).toHaveBeenCalledWith(KEY);
  });
});
