import { Controller, Delete, Get, Param } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { RequireSection } from '../../iam/decorators/require-section.decorator';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { OrphanedClaimsService } from './services/orphaned-claims.service';
import { OrphanedClaimsDto } from './dto/orphaned-claims.dto';

/**
 * The storage that outlived its application.
 *
 * Its own controller rather than two more methods on `ClustersController`,
 * which is past a thousand lines; and its own path, because the existing
 * `GET infrastructure/clusters/orphan-volumes` is a different thing entirely —
 * provider block volumes with no cluster, not Kubernetes claims with no
 * application.
 */
@ApiTags('Infrastructure - Clusters')
@ApiBearerAuth()
@Controller('infrastructure/clusters/:id/storage')
export class ClusterOrphanedClaimsController {
  constructor(private readonly orphanedClaims: OrphanedClaimsService) {}

  @Get('orphaned-claims')
  @RequireSection('infrastructure')
  // Takes nothing from anybody — the `infrastructure` section admits only
  // `full`, which is `cluster:manage` at global scope, and every role holding
  // that holds `cluster:read` too. It is here because the credential ceiling
  // reads `@RequirePermission` and `@AppAction` and nothing else,
  // and this read is now the route of an MCP tool: without a permission on it
  // no agent key could ever be scoped away from the storage inventory.
  @RequirePermission(IAM_PERMISSION.CLUSTER_READ)
  @ApiOperation({
    summary: 'Volumes left behind by applications that no longer exist',
    description:
      'Scans the namespaces Flui puts applications in and reports every ' +
      'PersistentVolumeClaim that no pod mounts, no live StatefulSet could ' +
      'have made, and no existing application owns. Read-only.',
  })
  @ApiParam({ name: 'id', description: 'Cluster ID' })
  @ApiResponse({ status: 200, type: OrphanedClaimsDto })
  async list(@Param('id') id: string): Promise<OrphanedClaimsDto> {
    return this.orphanedClaims.list(id);
  }

  /**
   * Destroying is never a side effect of some other permission.
   *
   * The section gate alone already refused this — `SectionAccessGuard` lets no
   * unsafe verb through the read-only level — so this is not a route that was
   * open. What it was, was *invisible*: a permanent deletion whose only gate
   * was access to an area, while the neighbouring route that destroys a cluster
   * carries `cluster:destroy` on top of the same section. A volume full of
   * somebody's data is the same kind of act.
   *
   * `cluster:manage` and not `cluster:destroy`: this deletes storage inside a
   * cluster, not the cluster, and `maintainer` — who already governs the machines
   * — is the right holder. An `operator` reads the machines and does not manage
   * them, so it no longer reaches this by holding the section.
   *
   * It also brings the route inside the credential ceiling, which reads
   * `@RequirePermission` and `@AppAction` and nothing else: until now no agent
   * key could be scoped *away* from this deletion, because no scope named it.
   */
  @Delete('orphaned-claims/:namespace/:name')
  @RequireSection('infrastructure')
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  @ApiOperation({
    summary: 'Delete one abandoned volume',
    description:
      'Permanent. The check that put the claim on the list is re-run before ' +
      'anything is deleted, so a volume that has since been mounted or ' +
      'reclaimed is refused instead of removed.',
  })
  @ApiParam({ name: 'id', description: 'Cluster ID' })
  @ApiParam({ name: 'namespace', description: 'Namespace of the claim' })
  @ApiParam({ name: 'name', description: 'Name of the claim' })
  @ApiResponse({ status: 200, description: 'Removed' })
  @ApiResponse({ status: 400, description: 'No longer abandoned' })
  async remove(
    @Param('id') id: string,
    @Param('namespace') namespace: string,
    @Param('name') name: string,
  ) {
    return this.orphanedClaims.remove(id, namespace, name);
  }
}
