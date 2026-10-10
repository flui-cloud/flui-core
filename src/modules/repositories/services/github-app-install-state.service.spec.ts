import { GithubAppInstallStateService } from './github-app-install-state.service';

/** One cache for every copy of the API, as Redis is. */
const sharedCache = () => {
  const entries = new Map<string, unknown>();
  return {
    get: async (k: string) => entries.get(k),
    set: async (k: string, v: unknown) => {
      entries.set(k, v);
    },
    delete: async (k: string) => {
      entries.delete(k);
    },
  } as never;
};

describe('the state that ties an App install to its GitHub callback', () => {
  it('is redeemed by any copy of the API, once', async () => {
    const cache = sharedCache();
    const issuing = new GithubAppInstallStateService(cache);
    const receiving = new GithubAppInstallStateService(cache);
    const state = await issuing.issue('u1', 'http://127.0.0.1:5555/cb');
    expect(await receiving.consume(state)).toEqual({
      fluiUserId: 'u1',
      cliCallbackUrl: 'http://127.0.0.1:5555/cb',
    });
    expect(await receiving.consume(state)).toBeNull();
  });

  it('knows nothing of a state it never issued', async () => {
    const service = new GithubAppInstallStateService(sharedCache());
    expect(await service.consume('made-up')).toBeNull();
  });
});
