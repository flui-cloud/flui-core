import { Inject, Injectable, Logger } from '@nestjs/common';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ApplicationSourceType } from '../../applications/enums/application-source-type.enum';
import { ApplicationsRepository } from '../../applications/repositories/applications.repository';
import { AppRevisionsRepository } from '../../applications/repositories/app-revisions.repository';
import {
  AppEventActorType,
  AppEventType,
} from '../../applications/enums/app-event-type.enum';
import { ApplicationEventsGateway } from '../../applications/gateway/application-events.gateway';
import { CrashDiagnosesRepository } from '../repositories/crash-diagnoses.repository';
import { CrashDiagnosisEntity } from '../entities/crash-diagnosis.entity';
import { CrashCategory } from '../enums/crash-category.enum';
import { SuggestedActionType } from '../enums/suggested-action-type.enum';
import { ApplicationResources } from '../../applications/interfaces/source-config.interface';

export interface ActuatorDeployer {
  triggerDeployWithImage(
    applicationId: string,
    imageRef: string,
  ): Promise<unknown>;
}

export interface MemoryParser {
  parseMemory(value: string): number;
}

export const ACTUATOR_DEPLOYER = 'ACTUATOR_DEPLOYER';
export const ACTUATOR_MEMORY_PARSER = 'ACTUATOR_MEMORY_PARSER';

const DEFAULT_MEMORY_LIMIT_MI = 256;
const DEFAULT_MEMORY_CAP_MI = 8 * 1024; // 8Gi
const DEFAULT_MAX_AUTOFIX_PER_HOUR = 3;
const AUTOFIX_COOLDOWN_MS = 90_000;

@Injectable()
export class ActuatorService {
  private readonly logger = new Logger(ActuatorService.name);
  private readonly memoryCapMi: number;
  private readonly maxAutoFixPerHour: number;

  constructor(
    private readonly applicationsRepository: ApplicationsRepository,
    private readonly appRevisionsRepository: AppRevisionsRepository,
    private readonly crashDiagnosesRepository: CrashDiagnosesRepository,
    @Inject(ACTUATOR_DEPLOYER)
    private readonly deployer: ActuatorDeployer,
    @Inject(ACTUATOR_MEMORY_PARSER)
    private readonly memoryParser: MemoryParser,
    private readonly eventsGateway: ApplicationEventsGateway,
  ) {
    this.memoryCapMi = this.parseIntEnv(
      'SCALING_AUTOFIX_MEMORY_CAP_MI',
      DEFAULT_MEMORY_CAP_MI,
    );
    this.maxAutoFixPerHour = this.parseIntEnv(
      'SCALING_AUTOFIX_MAX_PER_HOUR',
      DEFAULT_MAX_AUTOFIX_PER_HOUR,
    );
  }

  async tryAutoFix(
    diagnosis: CrashDiagnosisEntity,
    app: ApplicationEntity,
  ): Promise<boolean> {
    if (diagnosis.category !== CrashCategory.OOM_KILLED) return false;

    if (!this.hasKernelOomEvidence(diagnosis)) {
      this.logger.warn(
        `Auto-fix skipped for ${app.slug}: diagnosis ${diagnosis.id} is categorised OOM_KILLED but its evidence reports lastTerminationReason=${diagnosis.evidence?.lastTerminationReason ?? 'none'} (exitCode=${diagnosis.evidence?.exitCode ?? 'none'}); raising the memory limit requires a kernel OOM kill`,
      );
      return false;
    }

    if (!this.isAutoFixEligible(app)) {
      this.logger.debug(
        `Auto-fix skipped for ${app.slug}: sourceType=${app.sourceType} not eligible`,
      );
      return false;
    }

    const fresh = (await this.applicationsRepository.findById(app.id)) ?? app;

    if (this.isDiagnosisStale(diagnosis, fresh)) {
      this.logger.debug(
        `Auto-fix skipped for ${fresh.slug}: diagnosis ${diagnosis.id} predates last deploy (diagnosedAt=${diagnosis.createdAt.toISOString()}, lastDeployedAt=${fresh.lastDeployedAt?.toISOString()})`,
      );
      return false;
    }

    const recentEvents = await this.findRecentAutoFixEvents(fresh.id);

    if (this.hasAutoFixWithinCooldown(recentEvents)) {
      this.logger.debug(
        `Auto-fix skipped for ${fresh.slug}: another auto-fix occurred within the last ${AUTOFIX_COOLDOWN_MS}ms`,
      );
      return false;
    }

    const recentCount = this.countAutoFixesWithinHour(recentEvents);
    if (recentCount >= this.maxAutoFixPerHour) {
      this.logger.warn(
        `Auto-fix rate limit hit for ${fresh.slug}: ${recentCount} fixes in last hour`,
      );
      return false;
    }

    const currentLimitMi = this.getCurrentMemoryLimitMi(fresh);
    const newLimitMi = Math.min(currentLimitMi * 2, this.memoryCapMi);

    if (newLimitMi <= currentLimitMi) {
      this.logger.warn(
        `Auto-fix skipped for ${fresh.slug}: already at memory cap (${currentLimitMi}Mi >= ${this.memoryCapMi}Mi)`,
      );
      return false;
    }

    const previousLimit = this.formatMemory(currentLimitMi);
    const newLimit = this.formatMemory(newLimitMi);

    this.logger.log(
      `Auto-fix OOMKilled for ${fresh.slug}: memory limit ${previousLimit} → ${newLimit}`,
    );

    const updatedResources: ApplicationResources = {
      ...fresh.resources,
      memory: {
        ...fresh.resources?.memory,
        limit: newLimit,
      },
    };
    await this.applicationsRepository.update(fresh.id, {
      resources: updatedResources,
    });

    await this.appRevisionsRepository.createAuditEvent({
      applicationId: fresh.id,
      eventType: AppEventType.RESOURCE_UPDATE,
      actor: { type: AppEventActorType.SYSTEM, id: 'actuator' },
      changeMetadata: {
        autoFix: true,
        reason: 'OOMKilled',
        diagnosisId: diagnosis.id,
        previousMemoryLimit: previousLimit,
        newMemoryLimit: newLimit,
      },
      resourcesSnapshot: updatedResources,
    });

    await this.crashDiagnosesRepository.updateSuggestedAction(diagnosis.id, {
      type: SuggestedActionType.AUTO,
      message: `Memory limit automatically increased from ${previousLimit} to ${newLimit}. The app is being redeployed.`,
      payload: {
        autoFix: true,
        previousMemoryLimit: previousLimit,
        newMemoryLimit: newLimit,
      },
    });

    this.eventsGateway.emitAutoRemediation(fresh.id, {
      appId: fresh.id,
      diagnosisId: diagnosis.id,
      reason: 'OOMKilled',
      action: 'memory-limit-increase',
      previousMemoryLimit: previousLimit,
      newMemoryLimit: newLimit,
      timestamp: new Date(),
    });

    try {
      if (!fresh.imageRef) {
        this.logger.warn(
          `Auto-fix for ${fresh.slug}: app has no imageRef, cannot trigger deploy`,
        );
        return false;
      }
      await this.deployer.triggerDeployWithImage(fresh.id, fresh.imageRef);
    } catch (err) {
      this.logger.error(
        `Auto-fix deploy enqueue failed for ${fresh.slug}: ${(err as Error).message}`,
      );
      return false;
    }

    return true;
  }

  // Independent of the diagnostic engine on purpose: doubling memory is
  // irreversible for the user's bill and must never rest on an inference.
  private hasKernelOomEvidence(diagnosis: CrashDiagnosisEntity): boolean {
    return diagnosis.evidence?.lastTerminationReason === 'OOMKilled';
  }

  private isAutoFixEligible(app: ApplicationEntity): boolean {
    // Auto-remediation runs only on user apps. SystemApps (raw manifests
    // bootstrapped by Flui itself) are marked systemProtected and never get
    // auto-fix; their resources are tuned out-of-band.
    if (app.systemProtected) return false;
    return (
      app.sourceType === ApplicationSourceType.DOCKER_IMAGE ||
      app.sourceType === ApplicationSourceType.GIT_BUILD
    );
  }

  private isDiagnosisStale(
    diagnosis: CrashDiagnosisEntity,
    app: ApplicationEntity,
  ): boolean {
    if (!app.lastDeployedAt) return false;
    return diagnosis.createdAt.getTime() < app.lastDeployedAt.getTime();
  }

  private async findRecentAutoFixEvents(
    applicationId: string,
  ): Promise<Array<{ createdAt: Date }>> {
    const { events } = await this.appRevisionsRepository.findAllEvents(
      applicationId,
      { eventType: AppEventType.RESOURCE_UPDATE, limit: 50 },
    );
    return events.filter((e) => e.changeMetadata?.autoFix === true);
  }

  private hasAutoFixWithinCooldown(
    events: Array<{ createdAt: Date }>,
  ): boolean {
    const cutoff = Date.now() - AUTOFIX_COOLDOWN_MS;
    return events.some((e) => e.createdAt.getTime() >= cutoff);
  }

  private countAutoFixesWithinHour(events: Array<{ createdAt: Date }>): number {
    const cutoff = Date.now() - 60 * 60 * 1000;
    return events.filter((e) => e.createdAt.getTime() >= cutoff).length;
  }

  private getCurrentMemoryLimitMi(app: ApplicationEntity): number {
    const raw = app.resources?.memory?.limit;
    if (!raw) return DEFAULT_MEMORY_LIMIT_MI;
    const mi = this.memoryParser.parseMemory(raw);
    return mi > 0 ? mi : DEFAULT_MEMORY_LIMIT_MI;
  }

  private formatMemory(mi: number): string {
    if (mi >= 1024 && mi % 1024 === 0) return `${mi / 1024}Gi`;
    return `${mi}Mi`;
  }

  private parseIntEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }
}
