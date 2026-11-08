import { ClusterHaState } from '../../../cluster-ha/utils/cluster-ha.core';
import { haNodeRefusal } from './ha-node-request.core';

const state = (over: Partial<ClusterHaState> = {}): ClusterHaState =>
  ({
    level: 'standard',
    region: 'eu-central',
    unsupported: null,
    topology: {
      validated: true,
      measured: true,
      zones: [
        {
          zone: 'fsn1',
          role: 'data',
          servers: ['lab-master'],
          dataHosts: ['lab-master', 'lab-worker-2'],
        },
        {
          zone: 'nbg1',
          role: 'data',
          servers: [],
          dataHosts: ['lab-worker-1'],
        },
        { zone: 'hel1', role: 'vote', servers: [], dataHosts: [] },
      ],
    },
    missing: [
      { role: 'server', zone: 'nbg1', why: '' },
      { role: 'server', zone: 'hel1', why: '' },
    ],
    ...over,
  }) as unknown as ClusterHaState;

describe('which node an operator may add for high availability', () => {
  it('adds what the view lists as missing', () => {
    expect(haNodeRefusal('lab', state(), 'server', 'hel1')).toBeNull();
    expect(haNodeRefusal('lab', state(), 'server', 'nbg1')).toBeNull();
  });

  it('refuses a second server in a location, and says how a lost one is replaced', () => {
    expect(haNodeRefusal('lab', state(), 'server', 'fsn1')).toContain(
      'fsn1 already has a server (lab-master)',
    );
  });

  it('keeps nodes for data out of the voting location', () => {
    expect(haNodeRefusal('lab', state(), 'data-host', 'hel1')).toContain(
      'hel1 only votes',
    );
    expect(haNodeRefusal('lab', state(), 'data-host', 'nbg1')).toContain(
      'nbg1 already has a node for data',
    );
  });

  it('refuses a location outside the layout, and a region without one', () => {
    expect(haNodeRefusal('lab', state(), 'server', 'ash')).toContain(
      'ash is not one of lab',
    );
    expect(
      haNodeRefusal(
        'lab',
        state({
          unsupported:
            'Flui has not validated a highly available layout for us-east yet.',
        }),
        'server',
        'ash',
      ),
    ).toContain('not validated');
  });
});
