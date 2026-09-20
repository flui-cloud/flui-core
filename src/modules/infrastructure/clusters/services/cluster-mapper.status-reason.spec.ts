// Pulled in transitively and ship ESM that jest won't parse; unused on this path.
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));

import { ClusterMapperService } from './cluster-mapper.service';
import { ClusterEntity } from '../entities/cluster.entity';

/**
 * A status is a word; a person needs the sentence. `deletion_failed` was
 * recorded with its reason and nothing ever served it, so six minutes of it
 * said nothing while the operation underneath named cause and remedy.
 */
describe('why a cluster is in the state it is', () => {
  const mapper = new ClusterMapperService();
  const cluster = (metadata: Record<string, unknown>) =>
    ({
      id: 'c1',
      name: 'wl-test',
      status: 'deletion_failed',
      nodes: [],
      metadata,
    }) as unknown as ClusterEntity;

  it('serves the reason a deletion failed', () => {
    const dto = mapper.mapToDto(
      cluster({
        deletionError:
          'The provider still has 2 server(s) after 300s: wl-test-master (running). A running server is not deleted unless deletion is forced.',
      }),
    );
    expect(dto.statusReason).toMatch(/running server is not deleted/);
  });

  it('says nothing when there is nothing to say', () => {
    expect(mapper.mapToDto(cluster({})).statusReason).toBeUndefined();
    expect(
      mapper.mapToDto(cluster({ deletionError: '' })).statusReason,
    ).toBeUndefined();
  });

  it('does not invent a reason out of some other metadata', () => {
    const dto = mapper.mapToDto(cluster({ vnetConfig: { vnetId: 'v1' } }));
    expect(dto.statusReason).toBeUndefined();
    expect(dto.vnetId).toBe('v1');
  });
});
