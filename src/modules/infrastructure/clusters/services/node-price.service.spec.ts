import { NodePriceService } from './node-price.service';
import { NodeSizeDto } from '../../../providers/dto/node-size.dto';

const size = (over: Partial<NodeSizeDto> = {}): NodeSizeDto =>
  ({
    id: 'cx32',
    name: 'cx32',
    prices: [
      {
        location: 'fsn1',
        priceHourly: { net: '0.0092', gross: '0.0109' },
        priceMonthly: { net: '5.83', gross: '6.94' },
      },
      {
        location: 'hel1',
        priceHourly: { net: '0.0071', gross: '0.0084' },
        priceMonthly: { net: '4.50', gross: '5.36' },
      },
    ],
    ...over,
  }) as NodeSizeDto;

const build = (sizes: NodeSizeDto[] | Error) => {
  const getNodeSizes = jest.fn(async () => {
    if (sizes instanceof Error) throw sizes;
    return sizes;
  });
  const factory = {
    getProvider: () => {
      if (sizes instanceof Error) throw sizes;
      return { getNodeSizes };
    },
  };
  return {
    service: new NodePriceService(factory as never),
    getNodeSizes,
  };
};

describe('NodePriceService', () => {
  it('picks the price of the location the node actually sits in', async () => {
    const { service } = build([size()]);
    await expect(
      service.resolveHourlyEur('hetzner', 'cx32', 'hel1'),
    ).resolves.toBe(0.0071);
  });

  it('falls back to the first location when none is given', async () => {
    const { service } = build([size()]);
    await expect(service.resolveHourlyEur('hetzner', 'cx32')).resolves.toBe(
      0.0092,
    );
  });

  it('returns null rather than zero when the size is unknown', async () => {
    const { service } = build([size()]);
    await expect(
      service.resolveHourlyEur('hetzner', 'cx99', 'fsn1'),
    ).resolves.toBeNull();
  });

  it('returns null when there is no size at all', async () => {
    const { service } = build([size()]);
    await expect(service.resolveHourlyEur('byos', null)).resolves.toBeNull();
  });

  it('returns null when the provider is unreachable', async () => {
    const { service } = build(new Error('provider down'));
    await expect(
      service.resolveHourlyEur('hetzner', 'cx32', 'fsn1'),
    ).resolves.toBeNull();
  });

  it('asks the provider once per provider, not once per node', async () => {
    const { service, getNodeSizes } = build([size()]);
    await service.resolveHourlyEur('hetzner', 'cx32', 'fsn1');
    await service.resolveHourlyEur('hetzner', 'cx32', 'hel1');
    expect(getNodeSizes).toHaveBeenCalledTimes(1);
  });
});
