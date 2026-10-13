const get = jest.fn();
jest.mock('./repositories/cli-cluster.repository', () => ({
  CliClusterRepository: jest.fn().mockImplementation(() => ({
    find: async () => [],
  })),
}));
jest.mock('./config-storage', () => ({
  ConfigStorage: jest.fn().mockImplementation(() => ({
    getApiUrlOrThrow: () => 'http://api.example.test/api/v1',
    getApiKey: () => 'flui_visitor',
  })),
}));
jest.mock('./api-client', () => {
  const actual = jest.requireActual('./api-client');
  return {
    ...actual,
    ApiClient: jest.fn().mockImplementation(() => ({ get })),
  };
});

import { ApiError } from './api-client';
import { listClusters } from './cluster-listing';
import { resolveClusterRef } from './resolve-cluster';

describe('listClusters', () => {
  beforeEach(() => get.mockReset());

  it('lets a visit that ended through, instead of reporting no clusters', async () => {
    get.mockRejectedValue(
      new ApiError('Your visit has ended. Start a new one', 401, {
        code: 'VISITOR_GONE',
      }),
    );
    await expect(listClusters()).rejects.toThrow('Your visit has ended');
    await expect(resolveClusterRef()).rejects.toThrow(/^Your visit has ended/);
    await expect(resolveClusterRef()).rejects.not.toThrow('flui env create');
  });

  it('still falls back to the local list for any other failure', async () => {
    get.mockRejectedValue(new ApiError('Invalid or revoked API key', 401, {}));
    await expect(listClusters()).resolves.toEqual({
      clusters: [],
      apiError: 'Invalid or revoked API key',
    });
  });
});
