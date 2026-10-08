import { resolveUserId, setBlocked } from './user-block-client';

describe('blocking from the CLI', () => {
  const api = (users: Array<{ id: string; email: string }>) => {
    const posts: Array<{ path: string; body: unknown }> = [];
    return {
      posts,
      client: {
        get: async () => users,
        post: async (path: string, body: unknown) => {
          posts.push({ path, body });
          return {
            id: 'x',
            email: 'a@b.c',
            blockedAt: 'now',
            blockedReason: null,
          };
        },
      } as never,
    };
  };

  it('finds a person by their exact address', async () => {
    const { client } = api([
      { id: 'idp-1', email: 'mario@example.com' },
      { id: 'idp-2', email: 'mario@example.com.evil' },
    ]);
    expect(await resolveUserId(client, 'Mario@Example.com')).toBe('idp-1');
  });

  it('refuses an address that matches nobody', async () => {
    const { client } = api([]);
    await expect(resolveUserId(client, 'ghost@example.com')).rejects.toThrow(
      /No person/,
    );
  });

  it('takes an id as it is', async () => {
    const { client } = api([]);
    expect(await resolveUserId(client, 'idp-9')).toBe('idp-9');
  });

  it('posts the reason with a block and nothing with an unblock', async () => {
    const { client, posts } = api([]);
    await setBlocked(client, 'idp-9', true, 'mining');
    await setBlocked(client, 'idp-9', false);
    expect(posts).toEqual([
      { path: '/auth/users/idp-9/block', body: { reason: 'mining' } },
      { path: '/auth/users/idp-9/unblock', body: {} },
    ]);
  });
});
