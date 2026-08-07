import { ActuatorService } from './actuator.service';
import { ApplicationSourceType } from '../../applications/enums/application-source-type.enum';
import { ApplicationStatus } from '../../applications/enums/application-status.enum';
import { ApplicationCategory } from '../../applications/enums/application-category.enum';
import { ReconciliationStatus } from '../../infrastructure/shared/enums/reconciliation-status.enum';
import { AppEventType } from '../../applications/enums/app-event-type.enum';
import { CrashCategory } from '../enums/crash-category.enum';
import { DiagnosisSeverity } from '../enums/diagnosis-severity.enum';
import { SuggestedActionType } from '../enums/suggested-action-type.enum';
import { CrashDiagnosisEntity } from '../entities/crash-diagnosis.entity';
import { ApplicationEntity } from '../../applications/entities/application.entity';

const parseMemory = (value: string): number => {
  if (!value) return 0;
  if (value.endsWith('Mi')) return Number.parseInt(value, 10);
  if (value.endsWith('Gi')) return Number.parseFloat(value) * 1024;
  return Number.parseInt(value, 10);
};

function buildApp(
  overrides: Partial<ApplicationEntity> = {},
): ApplicationEntity {
  return {
    id: 'app-1',
    slug: 'my-app',
    name: 'my-app',
    sourceType: ApplicationSourceType.DOCKER_IMAGE,
    category: ApplicationCategory.USER,
    systemProtected: false,
    status: ApplicationStatus.RUNNING,
    reconciliationStatus: ReconciliationStatus.IN_SYNC,
    clusterId: 'cluster-1',
    k8sNamespace: 'default',
    imageRef: 'ghcr.io/org/app:v1',
    replicas: 1,
    env: [],
    resources: { memory: { limit: '256Mi' } },
    scaling: { enabled: false },
    labels: {},
    metadata: {},
    sourceConfig: {} as any,
    isFluiManaged: true,
    autoDeploy: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as ApplicationEntity;
}

function buildDiagnosis(
  category: CrashCategory = CrashCategory.OOM_KILLED,
): CrashDiagnosisEntity {
  return {
    id: 'diag-1',
    applicationId: 'app-1',
    podName: 'my-app-abc',
    containerName: 'main',
    category,
    severity: DiagnosisSeverity.CRITICAL,
    title: 'test',
    explanation: 'test',
    evidence: { exitCode: 137, lastTerminationReason: 'OOMKilled' },
    patternMatchedKey: null,
    suggestedAction: { type: SuggestedActionType.MANUAL, message: 'test' },
    podSnapshot: {},
    resolvedAt: null,
    createdAt: new Date(),
  } as CrashDiagnosisEntity;
}

describe('ActuatorService', () => {
  const createService = (
    recentEvents: Array<{
      createdAt: Date;
      changeMetadata: Record<string, unknown>;
    }> = [],
    freshApp: ApplicationEntity | null = null,
  ) => {
    const updateApp = jest.fn().mockResolvedValue(undefined);
    const findById = jest.fn().mockResolvedValue(freshApp);
    const createAuditEvent = jest.fn().mockResolvedValue(undefined);
    const updateSuggestedAction = jest.fn().mockResolvedValue(undefined);
    const triggerDeploy = jest.fn().mockResolvedValue({ id: 'op-1' });
    const emitAutoRemediation = jest.fn();

    const service = new ActuatorService(
      { update: updateApp, findById } as any,
      {
        createAuditEvent,
        findAllEvents: jest.fn().mockResolvedValue({
          events: recentEvents,
          total: recentEvents.length,
        }),
      } as any,
      { updateSuggestedAction } as any,
      { triggerDeployWithImage: triggerDeploy } as any,
      { parseMemory } as any,
      { emitAutoRemediation } as any,
    );

    return {
      service,
      updateApp,
      findById,
      createAuditEvent,
      updateSuggestedAction,
      triggerDeploy,
      emitAutoRemediation,
    };
  };

  it('skips when diagnosis is not OOMKilled', async () => {
    const { service, triggerDeploy } = createService();
    const result = await service.tryAutoFix(
      buildDiagnosis(CrashCategory.CRASH_LOOP),
      buildApp(),
    );
    expect(result).toBe(false);
    expect(triggerDeploy).not.toHaveBeenCalled();
  });

  it('skips when the evidence is a bare SIGKILL rather than a kernel OOM', async () => {
    const { service, triggerDeploy, updateApp } = createService();
    const diagnosis = buildDiagnosis();
    diagnosis.evidence = { exitCode: 137, lastTerminationReason: 'Error' };

    const result = await service.tryAutoFix(diagnosis, buildApp());

    expect(result).toBe(false);
    expect(updateApp).not.toHaveBeenCalled();
    expect(triggerDeploy).not.toHaveBeenCalled();
  });

  it('skips when the evidence carries no termination reason at all', async () => {
    const { service, triggerDeploy } = createService();
    const diagnosis = buildDiagnosis();
    diagnosis.evidence = {};

    const result = await service.tryAutoFix(diagnosis, buildApp());

    expect(result).toBe(false);
    expect(triggerDeploy).not.toHaveBeenCalled();
  });

  it('skips for RAW_MANIFEST apps (system bootstrap)', async () => {
    const { service, triggerDeploy } = createService();
    const result = await service.tryAutoFix(
      buildDiagnosis(),
      buildApp({ sourceType: ApplicationSourceType.RAW_MANIFEST }),
    );
    expect(result).toBe(false);
    expect(triggerDeploy).not.toHaveBeenCalled();
  });

  it('skips for system-protected apps', async () => {
    const { service, triggerDeploy } = createService();
    const result = await service.tryAutoFix(
      buildDiagnosis(),
      buildApp({ systemProtected: true }),
    );
    expect(result).toBe(false);
    expect(triggerDeploy).not.toHaveBeenCalled();
  });

  it('doubles memory limit and triggers deploy for DOCKER_IMAGE', async () => {
    const ctx = createService();
    const result = await ctx.service.tryAutoFix(buildDiagnosis(), buildApp());
    expect(result).toBe(true);
    expect(ctx.updateApp).toHaveBeenCalledWith(
      'app-1',
      expect.objectContaining({
        resources: expect.objectContaining({
          memory: expect.objectContaining({ limit: '512Mi' }),
        }),
      }),
    );
    expect(ctx.createAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        applicationId: 'app-1',
        eventType: AppEventType.RESOURCE_UPDATE,
        changeMetadata: expect.objectContaining({
          autoFix: true,
          previousMemoryLimit: '256Mi',
          newMemoryLimit: '512Mi',
        }),
      }),
    );
    expect(ctx.updateSuggestedAction).toHaveBeenCalledWith(
      'diag-1',
      expect.objectContaining({ type: SuggestedActionType.AUTO }),
    );
    expect(ctx.triggerDeploy).toHaveBeenCalledWith(
      'app-1',
      'ghcr.io/org/app:v1',
    );
    expect(ctx.emitAutoRemediation).toHaveBeenCalled();
  });

  it('promotes to Gi when doubling crosses the 1Gi boundary', async () => {
    const ctx = createService();
    await ctx.service.tryAutoFix(
      buildDiagnosis(),
      buildApp({ resources: { memory: { limit: '512Mi' } } }),
    );
    expect(ctx.updateApp).toHaveBeenCalledWith(
      'app-1',
      expect.objectContaining({
        resources: expect.objectContaining({
          memory: expect.objectContaining({ limit: '1Gi' }),
        }),
      }),
    );
  });

  it('caps the memory limit at 8Gi and skips when already at cap', async () => {
    const ctx = createService();
    const result = await ctx.service.tryAutoFix(
      buildDiagnosis(),
      buildApp({ resources: { memory: { limit: '8Gi' } } }),
    );
    expect(result).toBe(false);
    expect(ctx.triggerDeploy).not.toHaveBeenCalled();
  });

  it('rate-limits auto-fixes to 3 per hour', async () => {
    const recent = [10, 20, 30].map((minutesAgo) => ({
      createdAt: new Date(Date.now() - minutesAgo * 60_000),
      changeMetadata: { autoFix: true },
    }));
    const ctx = createService(recent);
    const result = await ctx.service.tryAutoFix(buildDiagnosis(), buildApp());
    expect(result).toBe(false);
    expect(ctx.triggerDeploy).not.toHaveBeenCalled();
  });

  it('ignores stale autoFix events older than one hour when rate-limiting', async () => {
    const stale = Array.from({ length: 5 }, () => ({
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      changeMetadata: { autoFix: true },
    }));
    const ctx = createService(stale);
    const result = await ctx.service.tryAutoFix(buildDiagnosis(), buildApp());
    expect(result).toBe(true);
    expect(ctx.triggerDeploy).toHaveBeenCalled();
  });

  it('skips when diagnosis predates the last deploy (stale signal from old generation)', async () => {
    const lastDeployedAt = new Date();
    const fresh = buildApp({ lastDeployedAt });
    const ctx = createService([], fresh);
    const stale = buildDiagnosis();
    stale.createdAt = new Date(lastDeployedAt.getTime() - 60_000);
    const result = await ctx.service.tryAutoFix(stale, buildApp());
    expect(result).toBe(false);
    expect(ctx.triggerDeploy).not.toHaveBeenCalled();
    expect(ctx.updateApp).not.toHaveBeenCalled();
  });

  it('proceeds when diagnosis is newer than the last deploy', async () => {
    const lastDeployedAt = new Date(Date.now() - 60_000);
    const fresh = buildApp({ lastDeployedAt });
    const ctx = createService([], fresh);
    const result = await ctx.service.tryAutoFix(buildDiagnosis(), buildApp());
    expect(result).toBe(true);
    expect(ctx.triggerDeploy).toHaveBeenCalled();
  });

  it('skips when another auto-fix occurred within the cooldown window', async () => {
    const recent = [
      {
        createdAt: new Date(Date.now() - 30_000),
        changeMetadata: { autoFix: true },
      },
    ];
    const ctx = createService(recent);
    const result = await ctx.service.tryAutoFix(buildDiagnosis(), buildApp());
    expect(result).toBe(false);
    expect(ctx.triggerDeploy).not.toHaveBeenCalled();
    expect(ctx.updateApp).not.toHaveBeenCalled();
  });

  it('skips deploy when app has no imageRef', async () => {
    const ctx = createService();
    const result = await ctx.service.tryAutoFix(
      buildDiagnosis(),
      buildApp({ imageRef: undefined }),
    );
    expect(result).toBe(false);
    expect(ctx.triggerDeploy).not.toHaveBeenCalled();
  });
});
