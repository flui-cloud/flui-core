// The controller's import graph reaches an ESM-only Kubernetes client ts-jest
// cannot transform; this suite reads decorators and touches none of it.
jest.mock('@kubernetes/client-node', () => ({}));

import { Reflector } from '@nestjs/core';
import { ClusterOrphanedClaimsController } from './cluster-orphaned-claims.controller';
import { REQUIRED_PERMISSION_KEY } from '../../iam/decorators/require-permission.decorator';
import { REQUIRED_SECTION_KEY } from '../../iam/decorators/require-section.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { ALL_TOOLS } from '../../mcp/tools/tool-registry';

/**
 * Deleting a volume for good must not be a side effect of reaching an area.
 *
 * The route was never *open* — the section guard refuses every unsafe verb at
 * the read-only level — but its only gate was the section, while the
 * neighbouring route that destroys a cluster carries `cluster:destroy` on top
 * of the same section.
 *
 * There is a second thing this pins, and it is the one that is easy to lose:
 * the credential ceiling reads `@RequirePermission` and `@AppAction` and
 * nothing else, so a route carrying neither is invisible to it — no scope names
 * it, therefore no agent key can be scoped away from it. The decorator is what
 * puts this deletion inside the ceiling at all.
 */
describe('deleting an abandoned volume', () => {
  const reflector = new Reflector();

  it('asks for cluster:manage on top of the section, not the section alone', () => {
    const handler = ClusterOrphanedClaimsController.prototype.remove;

    expect(reflector.get(REQUIRED_SECTION_KEY, handler)).toBe('infrastructure');
    expect(reflector.get(REQUIRED_PERMISSION_KEY, handler)).toBe(
      IAM_PERMISSION.CLUSTER_MANAGE,
    );
  });

  /**
   * The read keeps the section it always had and gains `cluster:read`, which is
   * not the write's permission and closes the page to nobody: entering
   * `infrastructure` at `full` is `cluster:manage` at global scope, and every
   * role that holds that holds `cluster:read` too.
   *
   * It is here for the same reason the `DELETE` carries one — the ceiling sees
   * only `@RequirePermission` and `@AppAction` — and it matters now that the
   * listing has an agent caller (`cluster_orphaned_volumes`). The two
   * permissions are deliberately different: describing what is abandoned and
   * destroying it are not the same act.
   */
  it('gives the listing the read permission, not the write one', () => {
    const handler = ClusterOrphanedClaimsController.prototype.list;

    expect(reflector.get(REQUIRED_SECTION_KEY, handler)).toBe('infrastructure');
    expect(reflector.get(REQUIRED_PERMISSION_KEY, handler)).toBe(
      IAM_PERMISSION.CLUSTER_READ,
    );
  });

  /**
   * The half of the pair that has no agent at all. `cluster_orphaned_volumes`
   * reads; nothing in the catalogue calls the `DELETE`, and that is the
   * decision, not an omission — an agent that describes abandoned storage is
   * useful and has no blast radius, one that deletes it destroys data for good.
   */
  it('is reachable by an agent for reading and by no agent for deleting', () => {
    const declared = ALL_TOOLS.flatMap((t) => t.routes ?? []);
    const claims = declared.filter((r) =>
      r.includes('/storage/orphaned-claims'),
    );

    expect(claims).toEqual([
      'GET /infrastructure/clusters/:id/storage/orphaned-claims',
    ]);
    expect(
      declared.some(
        (r) => r.startsWith('DELETE') && r.includes('orphaned-claims'),
      ),
    ).toBe(false);
  });
});
