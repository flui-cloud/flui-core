import { allServerTypes } from './all-server-types';

const page = (names: string[], lastPage: number) => ({
  data: {
    server_types: names.map((name) => ({ name })),
    meta: { pagination: { last_page: lastPage } },
  },
});

describe("Hetzner's whole list of server types", () => {
  it('reads past the first page, where the newest types land', async () => {
    const listServerTypes = jest
      .fn()
      .mockResolvedValueOnce(page(['cpx11', 'ccx13'], 2))
      .mockResolvedValueOnce(page(['cx23', 'cx33'], 2));

    const types = await allServerTypes({ listServerTypes } as never);

    expect(types.map((t) => t.name)).toEqual([
      'cpx11',
      'ccx13',
      'cx23',
      'cx33',
    ]);
    expect(listServerTypes).toHaveBeenNthCalledWith(2, undefined, 2, 50);
  });

  it('stops after one page when that is all there is', async () => {
    const listServerTypes = jest
      .fn()
      .mockResolvedValue({ data: { server_types: [{ name: 'cx23' }] } });

    const types = await allServerTypes({ listServerTypes } as never);

    expect(types).toHaveLength(1);
    expect(listServerTypes).toHaveBeenCalledTimes(1);
  });
});
