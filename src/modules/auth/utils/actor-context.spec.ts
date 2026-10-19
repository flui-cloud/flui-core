import { currentClientIp, runWithActorContext } from './actor-context';

describe('the client address in the request context', () => {
  it('is what the request opened the context with', async () => {
    const seen = await runWithActorContext(
      async () => currentClientIp(),
      '203.0.113.9',
    );

    expect(seen).toBe('203.0.113.9');
  });

  it('is unknown without an address or outside a request', async () => {
    expect(
      await runWithActorContext(async () => currentClientIp()),
    ).toBeUndefined();
    expect(currentClientIp()).toBeUndefined();
  });
});
