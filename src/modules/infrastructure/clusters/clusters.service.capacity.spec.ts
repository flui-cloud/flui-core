jest.mock('@kubernetes/client-node', () => ({}));
import { ClustersService } from './clusters.service';
import { WhatIfAnswer } from '../scaling/engine/what-if.core';

const NO_ROOM = { cpu: 4000, memory: 6000 };
const FULL = { cpu: 3500, memory: 5300 };

function build(options: {
  driven: boolean;
  placement: WhatIfAnswer | null | Error;
}) {
  const engine = {
    whatIf: jest.fn(async () => {
      if (options.placement instanceof Error) throw options.placement;
      return options.placement;
    }),
  };
  const service = new ClustersService(
    {
      findOne: jest.fn().mockResolvedValue({ id: 'c1', provider: 'hetzner' }),
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { getKubeconfig: jest.fn().mockResolvedValue('kc') } as never,
    {} as never,
    {} as never,
    {
      getNodeAllocatable: jest.fn().mockResolvedValue(NO_ROOM),
      getPodResourceRequests: jest.fn().mockResolvedValue(FULL),
    } as never,
    {
      resolveFacts: jest.fn().mockResolvedValue({
        nodeProvisioning: true,
        driven: options.driven,
        hasSizeCatalog: true,
      }),
    } as never,
    { get: () => engine } as never,
  );
  return { service, engine };
}

const answer = (over: Partial<WhatIfAnswer>): WhatIfAnswer => ({
  verdict: 'nothing-hosts',
  sentence: 'It would wait.',
  node: null,
  groupId: 'g1',
  provision: 'automatic',
  shape: null,
  region: null,
  monthlyEur: null,
  why: null,
  largest: null,
  ...over,
});

describe('the capacity gate, when the free total is not enough', () => {
  it('promises a node only when the engine names the machine it would buy', async () => {
    const { service } = build({
      driven: true,
      placement: answer({
        verdict: 'buys',
        shape: 'cx33',
        region: 'fsn1',
        sentence: 'Flui would buy a cx33 in fsn1 (€8.49 a month).',
      }),
    });
    const check = await service.checkResourceAvailability('c1', 500, 6144);
    expect(check.canDeploy).toBe(true);
    expect(check.reason).toBe('autoscaling_pending');
    expect(check.reasonMessage).toContain('cx33 in fsn1');
    expect(check.placement?.shape).toBe('cx33');
  });

  it('does not promise a node an automatic group cannot buy', async () => {
    const { service } = build({
      driven: true,
      placement: answer({
        sentence:
          'It does not fit on the nodes already there, and no machine the group may buy that could take it can be had right now: it would wait for room.',
        why: 'cx33 is sold out in fsn1, nbg1 and hel1. cx23 is too small.',
      }),
    });
    const check = await service.checkResourceAvailability('c1', 500, 6144);
    expect(check.canDeploy).toBe(false);
    expect(check.reason).toBe('insufficient_resources');
    expect(check.reasonMessage).toContain('would wait for room');
    expect(check.placement?.why).toContain('sold out');
  });

  it('takes the node-by-node answer over the aggregate when a node does have room', async () => {
    const { service } = build({
      driven: false,
      placement: answer({ verdict: 'fits', node: 'worker-1' }),
    });
    const check = await service.checkResourceAvailability('c1', 100, 256);
    expect(check.canDeploy).toBe(true);
    expect(check.reason).toBeNull();
  });

  it('falls back to the actuation rule when scaling cannot be asked', async () => {
    const { service } = build({ driven: true, placement: new Error('down') });
    const check = await service.checkResourceAvailability('c1', 500, 6144);
    expect(check.canDeploy).toBe(true);
    expect(check.reason).toBe('autoscaling_pending');
    expect(check.placement).toBeNull();
  });
});
