import { ApiClient } from './api-client';
import { resolveConnectedRepository, toOwnerRepo } from './resolve-repository';

const REPO_ID = '11111111-1111-1111-1111-111111111111';

const CONNECTED = [
  {
    id: REPO_ID,
    owner: 'acme',
    repositoryName: 'shop',
    repositoryFullName: 'acme/shop',
    defaultBranch: 'main',
  },
];

const apiWith = (rows: unknown[]): ApiClient =>
  ({ get: jest.fn().mockResolvedValue(rows) }) as unknown as ApiClient;

describe('toOwnerRepo', () => {
  it.each([
    ['acme/shop', 'acme/shop'],
    ['acme/shop.git', 'acme/shop'],
    ['https://github.com/acme/shop', 'acme/shop'],
    ['https://github.com/acme/shop.git', 'acme/shop'],
    ['https://github.com/acme/shop/tree/main', 'acme/shop'],
    ['/acme/shop/', 'acme/shop'],
  ])('reads %s as %s', (input, expected) => {
    expect(toOwnerRepo(input)).toBe(expected);
  });
});

describe('resolveConnectedRepository', () => {
  it('finds the repository by owner/repo', async () => {
    const repo = await resolveConnectedRepository(
      apiWith(CONNECTED),
      'acme/shop',
    );
    expect(repo.id).toBe(REPO_ID);
  });

  it('finds it by URL, and case-insensitively', async () => {
    await expect(
      resolveConnectedRepository(
        apiWith(CONNECTED),
        'https://github.com/ACME/Shop.git',
      ),
    ).resolves.toMatchObject({ id: REPO_ID });
  });

  it('finds it by id, which is what the routes are keyed on', async () => {
    await expect(
      resolveConnectedRepository(apiWith(CONNECTED), REPO_ID),
    ).resolves.toMatchObject({ repositoryFullName: 'acme/shop' });
  });

  /**
   * "Not connected" and "does not exist" have different remedies, and only one
   * of them is `flui repo connect`. Saying which repositories ARE connected is
   * what turns the refusal into the next command to type.
   */
  it('says it is not connected, names the ones that are, and gives the fix', async () => {
    await expect(
      resolveConnectedRepository(apiWith(CONNECTED), 'acme/other'),
    ).rejects.toThrow(
      /not connected[\s\S]*acme\/shop[\s\S]*repo connect acme\/other/,
    );
  });

  it('says so plainly when nothing is connected at all', async () => {
    await expect(
      resolveConnectedRepository(apiWith([]), 'acme/shop'),
    ).rejects.toThrow(/No repositories are connected/);
  });

  it('does not tell someone to connect a UUID', async () => {
    await expect(
      resolveConnectedRepository(
        apiWith(CONNECTED),
        '22222222-2222-2222-2222-222222222222',
      ),
    ).rejects.toThrow(/repo connect <owner\/repo>/);
  });
});
