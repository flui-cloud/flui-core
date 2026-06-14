import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CatalogInstallStatus } from '../enums/catalog-install-status.enum';
import { ResourceOverrides } from '../entities/catalog-install.entity';

export class CatalogInstallResponseDto {
  @ApiProperty() id: string;
  @ApiProperty() slug: string;
  @ApiProperty() displayName: string;
  @ApiProperty() catalogAppDefinitionId: string;
  @ApiProperty() clusterId: string;
  @ApiProperty({ enum: CatalogInstallStatus }) status: CatalogInstallStatus;
  @ApiPropertyOptional() operationId?: string;
  @ApiProperty({ type: [String] }) applicationIds: string[];
  @ApiPropertyOptional() requestedDomain?: string;

  @ApiPropertyOptional({
    description:
      'FQDN actually provisioned by Flui (either the requestedDomain or the auto-assigned one from the cluster DNS zone). Populated once the install reaches RUNNING. Null when skipEndpoint=true or the cluster has no DNS zone.',
  })
  resolvedFqdn?: string;

  @ApiProperty({
    description:
      'Whether endpoint provisioning was skipped. When true the user must configure DNS/TLS manually after install.',
  })
  skipEndpoint: boolean;

  @ApiProperty({
    description:
      'Whether dedicated-storage components were allowed to schedule on the control-plane node (set at install when the cluster had no worker). Defaults to false.',
  })
  allowMasterPlacement: boolean;

  @ApiPropertyOptional({
    description:
      'Effective resource overrides applied to this install (echoed from the install DTO). Null/undefined when the manifest defaults were accepted as-is.',
  })
  resourceOverrides?: ResourceOverrides;

  @ApiPropertyOptional({
    description:
      'For clients (manifests with spec.linkedBuildingBlocks): the CatalogInstall id of the building block this client is currently connected to. Derived on read from the client application env (the externalSecretRef → BB application → BB catalog install) — never stored on the install row, so it always reflects the actual running configuration. Null when the client is not connected (never connected, or disconnected via POST /installs/:id/disconnect). Always null for non-client apps. Use POST /installs/:id/connect with body { targetInstallId } to change it.',
  })
  connectedInstallId?: string | null;

  @ApiPropertyOptional({
    description:
      'Catalog slug of the building block this client is currently connected to (e.g. "postgresql", "mariadb", "valkey"). Same source of truth as connectedInstallId — derived from the client application env. Provided as a denormalization so the FE can render "Connected to <engine>" badges, pre-select filters in the Switch dialog, and choose engine-specific UI without a second GET to resolve the target install. Null when not connected.',
    example: 'postgresql',
  })
  connectedSlug?: string | null;

  @ApiPropertyOptional() errorMessage?: string;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}
