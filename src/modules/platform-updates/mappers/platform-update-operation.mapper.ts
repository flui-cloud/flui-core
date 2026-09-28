import {
  InfrastructureOperationEntity,
  PlatformUpdateOperationMetadata,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import {
  PlatformUpdateOperationDto,
  PlatformUpdatePhaseDto,
} from '../dto/platform-update-operation.dto';
import {
  PlatformUpgradeMetadata,
  isUpgradeMetadata,
} from '../interfaces/platform-upgrade.interface';

function phasesOf(metadata: PlatformUpgradeMetadata): PlatformUpdatePhaseDto[] {
  const k3s = metadata.k3sUpgrades ?? {};
  return metadata.phases.map((p) => ({
    key: p.key,
    title: p.title,
    status: p.status,
    startedAt: p.startedAt ?? null,
    finishedAt: p.finishedAt ?? null,
    deadlineAt: p.deadlineAt ?? null,
    ...(p.key === 'backup' ? { backupJobId: p.backupJobId ?? null } : {}),
    ...(p.message ? { message: p.message } : {}),
    ...(p.error ? { error: p.error } : {}),
    ...(p.checks ? { checks: p.checks } : {}),
    ...(p.clusters
      ? {
          clusters: p.clusters.map((c) => {
            const upgrade = p.key === 'k3s' ? k3s[c.clusterId] : undefined;
            return {
              clusterId: c.clusterId,
              clusterName: c.clusterName,
              clusterType: c.clusterType,
              status: c.status,
              ...(c.planId ? { planId: c.planId } : {}),
              ...(c.wrote ? { wrote: c.wrote } : {}),
              ...(c.error ? { error: c.error } : {}),
              ...(upgrade
                ? {
                    steps: upgrade.steps,
                    stepIndex: upgrade.stepIndex,
                    nodes: upgrade.nodes.map((n) => ({
                      name: n.name,
                      role: n.role,
                      fromVersion: n.fromVersion,
                      version: n.version,
                      status: n.status,
                      ...(n.message ? { message: n.message } : {}),
                    })),
                  }
                : {}),
            };
          }),
        }
      : {}),
  }));
}

export function toPlatformUpdateOperationDto(
  operation: InfrastructureOperationEntity,
): PlatformUpdateOperationDto {
  const metadata = operation.metadata as PlatformUpdateOperationMetadata;
  const phased = isUpgradeMetadata(metadata);
  return {
    id: operation.id,
    status: operation.status,
    fromVersion: metadata.fromVersion,
    targetVersion: metadata.targetVersion,
    components: (metadata.components ?? []).map((c) => ({
      key: c.key,
      name: c.name,
      fromVersion: c.fromVersion,
      targetVersion: c.targetVersion,
      status: c.status,
    })),
    migrations: metadata.migrations ?? 0,
    progress: operation.progress ?? 0,
    currentStep: operation.currentStep ?? null,
    awaitingSelfRestart: metadata.awaitingSelfRestart ?? false,
    startedAt: operation.startedAt?.toISOString() ?? null,
    completedAt: operation.completedAt?.toISOString() ?? null,
    errorMessage: operation.errorMessage ?? null,
    userId: operation.userId ?? null,
    schema: phased ? 2 : 1,
    ...(phased
      ? {
          planId: metadata.planId,
          k3sVersion: metadata.k3sVersion,
          withoutBackup: metadata.withoutBackup,
          phases: phasesOf(metadata),
          failedPhase: metadata.failedPhase ?? null,
          guidance: metadata.guidance ?? null,
        }
      : {}),
  };
}
