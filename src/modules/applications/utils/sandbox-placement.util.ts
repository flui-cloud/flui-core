import { CreateApplicationDto } from '../dto/create-application.dto';
import { UpdateApplicationDto } from '../dto/update-application.dto';
import { ApplicationCategory } from '../enums/application-category.enum';

/** Label keys the platform reads to find and own an application's objects. */
const RESERVED_LABEL =
  /^(app$|app\.kubernetes\.io\/|flui-|flui\.cloud\/|pod-security\.kubernetes\.io\/)/;

const ownLabels = (labels?: Record<string, string>) =>
  labels
    ? Object.fromEntries(
        Object.entries(labels).filter(([key]) => !RESERVED_LABEL.test(key)),
      )
    : labels;

/**
 * What a sandbox guest may decide about its own application. Placement (which
 * node, the control plane), the pod's companions, which claim or storage class a
 * volume binds, a workload on every node, the system category and the labels
 * the platform reads are infrastructure decisions taken for everyone sharing
 * the cluster: the guest's requests keep the fields, but they are dropped
 * before they reach the service. Every other caller is untouched.
 */
export function stripSandboxPlacementFields(dto: CreateApplicationDto): void {
  delete dto.persistenceScope;
  delete dto.dedicatedNodeName;
  delete dto.allowMasterPlacement;
  delete dto.projectId;
  delete dto.companions;
  delete dto.metadata;
  dto.labels = ownLabels(dto.labels);
  if (dto.workloadKind === 'DaemonSet') delete dto.workloadKind;
  if (dto.category === ApplicationCategory.SYSTEM)
    dto.category = ApplicationCategory.USER;
  dto.volumes = dto.volumes?.map(
    ({ claimNameOverride: _claim, storageClass: _class, ...volume }) => volume,
  );
}

/** The same decisions, on a change to an application a guest already has. */
export function stripSandboxUpdateFields(dto: UpdateApplicationDto): void {
  delete dto.metadata;
  delete (dto as { companions?: unknown }).companions;
  delete (dto as { workloadKind?: unknown }).workloadKind;
  delete (dto as { category?: unknown }).category;
  delete (dto as { dedicatedNodeName?: unknown }).dedicatedNodeName;
  delete (dto as { allowMasterPlacement?: unknown }).allowMasterPlacement;
  if (dto.labels) dto.labels = ownLabels(dto.labels);
  const volumes = (dto as { volumes?: Array<Record<string, unknown>> }).volumes;
  if (volumes) {
    (dto as { volumes?: unknown }).volumes = volumes.map(
      ({ claimNameOverride: _claim, storageClass: _class, ...volume }) =>
        volume,
    );
  }
}

/** Catalog installs carry the master-placement switch, the project and the capacity override. */
export function stripSandboxInstallPlacement(dto: {
  allowMasterPlacement?: boolean;
  projectId?: string;
  force?: boolean;
}): void {
  delete dto.allowMasterPlacement;
  delete dto.projectId;
  delete dto.force;
}
