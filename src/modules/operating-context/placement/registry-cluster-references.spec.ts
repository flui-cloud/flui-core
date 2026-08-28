import { RegistryClusterReferences } from './registry-cluster-references';

const ID = 'f94b9c06-cbc1-4c0e-a3b1-13aed149f490';

function resolverOver(rows: Array<{ id: string; name: string }>) {
  const findOne = jest.fn(
    async (opts: { where: { id?: string; name?: string } }) => {
      const found = rows.find((r) =>
        opts.where.id ? r.id === opts.where.id : r.name === opts.where.name,
      );
      return found ? { id: found.id } : null;
    },
  );
  return {
    resolver: new RegistryClusterReferences({ findOne } as never),
    findOne,
  };
}

describe('the one spelling of a cluster', () => {
  const rows = [{ id: ID, name: 'control-cluster' }];

  it('hands back an id unchanged', async () => {
    const { resolver } = resolverOver(rows);
    await expect(resolver.canonicalIdOf(ID)).resolves.toBe(ID);
  });

  it('turns a name into the id', async () => {
    const { resolver } = resolverOver(rows);
    await expect(resolver.canonicalIdOf('control-cluster')).resolves.toBe(ID);
  });

  /**
   * The `id` column is a `uuid`, so asking it about `control-cluster` makes
   * Postgres refuse the value — and the malformed-identifier filter then
   * answers "one of the values in this request is not a valid identifier",
   * which is true and answers the wrong question. Caught live: the honest
   * refusal, *no cluster answers to that*, never got said.
   */
  it('never asks the uuid column about something that is not one', async () => {
    const { resolver, findOne } = resolverOver(rows);
    await resolver.canonicalIdOf('control-cluster');

    expect(findOne).toHaveBeenCalledTimes(1);
    expect(findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { name: 'control-cluster' } }),
    );
  });

  it('answers null for a name nothing here carries', async () => {
    const { resolver } = resolverOver(rows);
    await expect(resolver.canonicalIdOf('nowhere')).resolves.toBeNull();
  });

  it('answers null for a well-formed id that is not here', async () => {
    const { resolver } = resolverOver(rows);
    await expect(
      resolver.canonicalIdOf('00000000-0000-4000-8000-000000000000'),
    ).resolves.toBeNull();
  });

  it('answers null for blank', async () => {
    const { resolver, findOne } = resolverOver(rows);
    await expect(resolver.canonicalIdOf('   ')).resolves.toBeNull();
    expect(findOne).not.toHaveBeenCalled();
  });

  /**
   * Two queries rather than one `OR`: a cluster whose *name* is another
   * cluster's id must not shadow it.
   */
  it('prefers the id when one row is named after another row id', async () => {
    const other = '11111111-1111-4111-8111-111111111111';
    const { resolver } = resolverOver([
      { id: ID, name: other },
      { id: other, name: 'the-other' },
    ]);
    await expect(resolver.canonicalIdOf(other)).resolves.toBe(other);
  });
});
