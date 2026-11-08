import { HaCreationPlanService } from './ha-creation-plan.service';
import { CloudProvider } from '../../../providers/enums/cloud-provider.enum';

describe('HaCreationPlanService on a region with three zones', () => {
  const zones = ['fr-par-1', 'fr-par-2', 'fr-par-3'];
  const service = new HaCreationPlanService(
    {
      getCapabilitiesService: () => ({
        nodeTopology: (location: string) =>
          location === 'fr-par'
            ? { zone: 'fr-par-1', region: 'fr-par' }
            : { zone: location, region: 'fr-par' },
        haTopologies: () => [
          {
            region: 'fr-par',
            zones,
            dataZones: zones,
            validated: true,
            measured: false,
          },
        ],
      }),
    } as never,
    {
      getProvider: () => ({
        getNodeSizes: jest.fn().mockResolvedValue([
          {
            name: 'PRO2-XXS',
            architecture: 'x86',
            availability: [{ location: 'fr-par', available: true, zones }],
          },
        ]),
      }),
    } as never,
  );

  it('starts in the first zone of the region the person picked, with a copy of the data in every zone', async () => {
    const plan = await service.preview({
      provider: CloudProvider.SCALEWAY,
      region: 'fr-par',
      shapes: ['PRO2-XXS'],
      completeLater: false,
    });

    expect(plan).toMatchObject({
      possible: true,
      region: 'fr-par',
      measured: false,
      servers: [
        { zone: 'fr-par-1', role: 'data', first: true },
        { zone: 'fr-par-2', role: 'data', first: false },
        { zone: 'fr-par-3', role: 'data', first: false },
      ],
    });
  });
});
