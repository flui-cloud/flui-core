import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApplicationDeployService } from '../../applications/services/application-deploy.service';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  PlatformUpdateOperationMetadata,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { DeclaredImageService } from './declared-image.service';

type Component = PlatformUpdateOperationMetadata['components'][number];

const CHILD_POLL_INTERVAL_MS = 5_000;
const CHILD_TIMEOUT_MS = 10 * 60 * 1_000;

/**
 * Moving one platform component to a new image, through the same deploy path
 * everything else uses. Shared by the image-only update and the phased one.
 */
@Injectable()
export class ImageRolloutService {
  private readonly logger = new Logger(ImageRolloutService.name);
  pollMs = CHILD_POLL_INTERVAL_MS;

  constructor(
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operationRepository: Repository<InfrastructureOperationEntity>,
    private readonly deployService: ApplicationDeployService,
    private readonly declaredImages: DeclaredImageService,
  ) {}

  /** Rolls one component out and waits for it; throws when it did not land. */
  async rollout(
    component: Component,
    applicationId: string | undefined,
  ): Promise<void> {
    if (!applicationId) {
      throw new Error(
        `${component.name} has no system-app row on the control cluster to deploy through.`,
      );
    }
    const child = await this.deployService.setDesiredImage(
      applicationId,
      component.imageRef,
    );
    const outcome = await this.awaitOperation(child.id);
    if (outcome !== OperationStatus.COMPLETED) {
      throw new Error(
        `${component.name} did not roll out to ${component.targetVersion} (deploy ${child.id} ended ${outcome}).`,
      );
    }
    // The live Deployment now runs the new tag; the manifest on the master still
    // declares the old one, and k3s re-applies that directory at every start.
    const declared = await this.declaredImages.pin(component.imageRef);
    if (declared.outcome === 'failed') {
      this.logger.warn(
        `${component.name} rolled out, but its manifest still declares the old image: ${declared.reason}`,
      );
    }
  }

  /** Starts replacing the API. The caller records the operation first: this process may end here. */
  async replaceControlPlane(
    component: Component,
    applicationId: string | undefined,
  ): Promise<void> {
    if (!applicationId) {
      throw new Error(
        'Flui API has no system-app row on the control cluster to deploy through.',
      );
    }
    this.logger.log(
      `Rolling out the control plane to ${component.targetVersion}; this process ends here and the new pod continues the operation.`,
    );
    await this.deployService.setDesiredImage(applicationId, component.imageRef);
  }

  private async awaitOperation(id: string): Promise<OperationStatus> {
    const deadline = Date.now() + CHILD_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const child = await this.operationRepository.findOne({ where: { id } });
      if (
        child &&
        child.status !== OperationStatus.PENDING &&
        child.status !== OperationStatus.IN_PROGRESS
      ) {
        return child.status;
      }
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
    return OperationStatus.FAILED;
  }
}
