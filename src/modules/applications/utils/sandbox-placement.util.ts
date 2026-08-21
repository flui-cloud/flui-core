import { CreateApplicationDto } from '../dto/create-application.dto';

/**
 * Node placement is an infrastructure decision (which machine hosts the
 * workload), not a tenancy one: a sandbox guest picking a node — or the
 * control plane — decides it for everyone sharing that machine. The guest's
 * HTTP requests keep the fields, but they are dropped before they reach the
 * service; every other caller is untouched.
 */
export function stripSandboxPlacementFields(dto: CreateApplicationDto): void {
  delete dto.persistenceScope;
  delete dto.dedicatedNodeName;
  delete dto.allowMasterPlacement;
}

/** Catalog installs only carry the master-placement switch; scope is the manifest's. */
export function stripSandboxInstallPlacement(dto: {
  allowMasterPlacement?: boolean;
}): void {
  delete dto.allowMasterPlacement;
}
