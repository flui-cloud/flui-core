import { In, IsNull } from 'typeorm';
import { BillingIntervalsService } from './billing-intervals.service';
import { NodeType } from '../entities/cluster-node.entity';

const AT = new Date('2026-09-28T10:00:00Z');

const input = {
  clusterId: 'c1',
  nodeId: 'n1',
  serverName: 'ovh-master',
  provider: 'ovh',
  region: 'gra',
  serverType: 'b3-8',
  nodeType: NodeType.MASTER,
  startedAt: AT,
};

const openRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'iv-1',
  clusterId: 'c1',
  nodeId: 'n1',
  provider: 'ovh',
  region: 'gra',
  serverType: 'b3-8',
  nodeType: NodeType.MASTER,
  startedAt: new Date('2026-09-01T00:00:00Z'),
  endedAt: null,
  ...overrides,
});

function build(open: Record<string, unknown>[]) {
  const nodes = {
    find: jest.fn(async () => open),
    update: jest.fn(async () => undefined),
    create: jest.fn((x) => x),
    save: jest.fn(async (x) => x),
  };
  const volumes = { update: jest.fn(async () => undefined) };
  const service = new BillingIntervalsService(nodes as never, volumes as never);
  return { service, nodes, volumes };
}

describe('opening a node lifetime', () => {
  it('opens one when the node has none', async () => {
    const t = build([]);
    await t.service.openNodeInterval(input);
    expect(t.nodes.find).toHaveBeenCalledWith({
      where: { nodeId: 'n1', endedAt: IsNull() },
      order: { startedAt: 'ASC' },
    });
    expect(t.nodes.update).not.toHaveBeenCalled();
    expect(t.nodes.save).toHaveBeenCalledTimes(1);
    expect(t.nodes.save.mock.calls[0][0]).toMatchObject({
      nodeId: 'n1',
      startedAt: AT,
      endedAt: null,
    });
  });

  it('keeps the lifetime already open when asked again for the same machine', async () => {
    const t = build([openRow()]);
    await t.service.openNodeInterval(input);
    expect(t.nodes.update).not.toHaveBeenCalled();
    expect(t.nodes.save).not.toHaveBeenCalled();
  });

  it('closes the old lifetime and opens the next when the machine changes size', async () => {
    const t = build([openRow({ serverType: 'b3-4' })]);
    await t.service.openNodeInterval(input);
    expect(t.nodes.update).toHaveBeenCalledWith(
      { id: In(['iv-1']), endedAt: IsNull() },
      { endedAt: AT },
    );
    expect(t.nodes.save).toHaveBeenCalledTimes(1);
  });

  it('closes the extra lifetimes of a node counted more than once', async () => {
    const t = build([
      openRow(),
      openRow({ id: 'iv-2' }),
      openRow({ id: 'iv-3' }),
    ]);
    await t.service.openNodeInterval(input);
    expect(t.nodes.update).toHaveBeenCalledWith(
      { id: In(['iv-2', 'iv-3']), endedAt: IsNull() },
      { endedAt: AT },
    );
    expect(t.nodes.save).not.toHaveBeenCalled();
  });

  it('opens nothing when the old lifetime could not be closed', async () => {
    const t = build([openRow({ serverType: 'b3-4' })]);
    t.nodes.update.mockRejectedValueOnce(new Error('connection reset'));
    await t.service.openNodeInterval(input);
    expect(t.nodes.save).not.toHaveBeenCalled();
  });
});

describe('closing a deleted cluster', () => {
  it('ends every open machine and volume lifetime of the cluster at the deletion time', async () => {
    const t = build([]);
    await t.service.closeClusterIntervals('c1', AT);
    expect(t.nodes.update).toHaveBeenCalledWith(
      { clusterId: 'c1', endedAt: IsNull() },
      { endedAt: AT },
    );
    expect(t.volumes.update).toHaveBeenCalledWith(
      { clusterId: 'c1', endedAt: IsNull() },
      { endedAt: AT },
    );
  });
});
