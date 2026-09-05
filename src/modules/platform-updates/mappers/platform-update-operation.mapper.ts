import {
  InfrastructureOperationEntity,
  PlatformUpdateOperationMetadata,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { PlatformUpdateOperationDto } from '../dto/platform-update-operation.dto';

export function toPlatformUpdateOperationDto(
  operation: InfrastructureOperationEntity,
): PlatformUpdateOperationDto {
  const metadata = operation.metadata as PlatformUpdateOperationMetadata;
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
  };
}
