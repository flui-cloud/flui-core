import { FluiOpenStackClient } from './openstack-volumes-client';

describe('FluiOpenStackClient.rebootServer', () => {
  function build() {
    const client = new FluiOpenStackClient({} as never);
    jest
      .spyOn(client as any, 'endpoint')
      .mockResolvedValue('https://nova.example');
    return client;
  }

  it('succeeds when Nova answers 202 with an empty body (post() throws SyntaxError parsing it as JSON)', async () => {
    const client = build();
    jest
      .spyOn(client as any, 'post')
      .mockRejectedValue(new SyntaxError('Unexpected end of JSON input'));

    await expect(
      client.rebootServer('GRA11', 'srv-1'),
    ).resolves.toBeUndefined();
  });

  it('still propagates a real HTTP error from post() (not a SyntaxError)', async () => {
    const client = build();
    jest
      .spyOn(client as any, 'post')
      .mockRejectedValue(new Error('OpenStack POST … → HTTP 409 conflict'));

    await expect(client.rebootServer('GRA11', 'srv-1')).rejects.toThrow(
      'HTTP 409',
    );
  });

  it('calls the Nova action endpoint with a SOFT reboot body', async () => {
    const client = build();
    const post = jest.spyOn(client as any, 'post').mockResolvedValue(undefined);

    await client.rebootServer('GRA11', 'srv-1');

    expect(post).toHaveBeenCalledWith(
      'https://nova.example/servers/srv-1/action',
      {
        reboot: { type: 'SOFT' },
      },
    );
  });
});
