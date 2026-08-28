import type { ScalingGroupResponseDto } from 'src/modules/infrastructure/scaling/dto/scaling-response.dto';
import { SCALING_ERROR } from 'src/modules/infrastructure/scaling/scaling-errors';
import { ApiClient, ApiError } from './api-client';
import {
  ScalingClient,
  isGroupId,
  pickGroup,
  scalingErrorLines,
} from './scaling-client';

const group = (name: string, id: string): ScalingGroupResponseDto =>
  ({ id, name }) as ScalingGroupResponseDto;

const general = group('general', '2f1c9e5a-0000-4000-8000-000000000001');
const heavy = group('heavy', '2f1c9e5a-0000-4000-8000-000000000002');

describe('isGroupId', () => {
  it('tells an id apart from a name', () => {
    expect(isGroupId('2f1c9e5a-0000-4000-8000-000000000001')).toBe(true);
    expect(isGroupId('general')).toBe(false);
  });
});

/**
 * A cluster may hold more than one group — that is why the group is a resource
 * — so `why` must never answer about a group nobody asked about.
 */
describe('pickGroup', () => {
  it('takes the only group when the cluster has one', () => {
    expect(pickGroup([general], 'Cluster "prod-eu"')).toBe(general);
  });

  it('matches by name, whatever the case', () => {
    expect(pickGroup([general, heavy], 'Cluster "prod-eu"', 'HEAVY')).toBe(
      heavy,
    );
  });

  it('matches by id', () => {
    expect(pickGroup([general, heavy], 'Cluster "prod-eu"', heavy.id)).toBe(
      heavy,
    );
  });

  it('asks which one instead of guessing', () => {
    expect(() => pickGroup([general, heavy], 'Cluster "prod-eu"')).toThrow(
      /2 scaling groups/,
    );
  });

  it('lists what exists when the named group does not', () => {
    expect(() => pickGroup([general], 'Cluster "prod-eu"', 'nope')).toThrow(
      /general/,
    );
  });

  it('points at the file when the cluster has no group at all', () => {
    expect(() => pickGroup([], 'Cluster "prod-eu"')).toThrow(
      /flui scaling apply -f/,
    );
  });
});

/**
 * Three refusals arrive as the same status, and only one of them is about the
 * installation. The API names the two that are about the request; the third —
 * a route this build does not serve — is Nest's own answer and carries no code,
 * so the absent code is the signal rather than the shape of a sentence.
 */
describe('scalingErrorLines', () => {
  const refusal = (code: string, message: string, status = 404) =>
    new ApiError(message, status, { statusCode: status, code, message });

  it('says so when the API has no scaling routes at all', () => {
    const lines = scalingErrorLines(
      new ApiError('Cannot GET /api/v1/infrastructure/scaling', 404),
    );
    expect(lines[0]).toContain('does not serve scaling groups');
    expect(lines).toHaveLength(2);
  });

  /**
   * The cluster route is newer than the rest of the surface, so a caller that
   * only misses that one must not be told the whole surface is absent.
   */
  it('lets a caller name the route that is missing, when it is a newer one', () => {
    const lines = scalingErrorLines(
      new ApiError('Cannot GET /api/v1/infrastructure/clusters/c1/x', 404),
      'Name a group instead.',
    );
    expect(lines[0]).toBe('Name a group instead.');
  });

  it('leaves a genuine missing group about the group', () => {
    const lines = scalingErrorLines(
      refusal(SCALING_ERROR.GROUP_NOT_FOUND, 'Scaling group abc not found'),
    );
    expect(lines[0]).toBe('Scaling group abc not found');
    expect(lines.join(' ')).not.toContain('does not serve scaling groups');
    expect(lines[1]).toContain('flui scaling list --cluster');
  });

  it('tells a missing cluster from a missing group, on the same status', () => {
    const lines = scalingErrorLines(
      refusal(SCALING_ERROR.CLUSTER_NOT_FOUND, 'Cluster abc not found'),
    );
    expect(lines[0]).toBe('Cluster abc not found');
    expect(lines[1]).toContain('flui cluster list');
  });

  it('says what a taken name means for a file that is applied again', () => {
    const lines = scalingErrorLines(
      refusal(
        SCALING_ERROR.GROUP_NAME_TAKEN,
        'Cluster c already has a scaling group named "general"',
        409,
      ),
    );
    expect(lines[1]).toContain('rewrites that group');
  });

  it('does not read every 404 as a missing surface once a code is there', () => {
    const lines = scalingErrorLines(new ApiError('Something else', 500));
    expect(lines).toEqual(['Something else']);
  });
});

describe('ScalingClient', () => {
  const asked: string[] = [];
  const client = new ScalingClient({
    get: (path: string) => {
      asked.push(path);
      return Promise.resolve([]);
    },
  } as unknown as ApiClient);

  beforeEach(() => {
    asked.length = 0;
  });

  /** The question is asked of a cluster, so there is a route that answers as one. */
  it('reads the decisions of a whole cluster without naming a group', async () => {
    await client.clusterDecisions('c1', 5);
    expect(asked).toEqual([
      '/infrastructure/clusters/c1/scaling-decisions?limit=5',
    ]);
  });

  it('still reads one group when a group is named', async () => {
    await client.decisions('g1', 3);
    expect(asked).toEqual([
      '/infrastructure/scaling-groups/g1/decisions?limit=3',
    ]);
  });

  /** `why` answers about a pass that ran; the preview asks the engine now. */
  it('asks the group itself what it would do right now', async () => {
    await client.preview('g1');
    expect(asked).toEqual(['/infrastructure/scaling-groups/g1/preview']);
  });
});
