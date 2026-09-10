import { EndpointDiagnosisService } from './endpoint-diagnosis.service';
import { CrashCategory } from '../enums/crash-category.enum';
import { DiagnosisSeverity } from '../enums/diagnosis-severity.enum';
import { SuggestedActionType } from '../enums/suggested-action-type.enum';

/**
 * `crash_diagnoses` was built for a container that dies and leaves a pod to
 * inspect. A public application with no endpoint has no crashing pod at all —
 * this is the "does it fit without forcing the model" question, answered:
 * `podName` takes a sentinel (the column is NOT NULL), `category` borrows the
 * unused `UNKNOWN` bucket rather than a new enum value (a new one is a
 * Postgres migration, out of scope here), and everything else — title,
 * explanation, suggestedAction, severity — carries the real content.
 */
describe('EndpointDiagnosisService', () => {
  const APP = {
    id: 'app-1',
    slug: 'flui-apply-probe-883q7r',
  } as any;

  const build = () => {
    const created: Array<Record<string, unknown>> = [];
    const resolvedCalls: Array<[string, string | null, CrashCategory]> = [];
    const emittedDiagnoses: unknown[] = [];
    const emittedResolutions: unknown[] = [];
    let resolvedCount = 1;

    const crashDiagnosesRepository = {
      create: async (data: Record<string, unknown>) => {
        created.push(data);
        return { id: 'diag-1', ...data };
      },
      markResolvedForContainer: async (
        applicationId: string,
        containerName: string | null,
        category: CrashCategory,
      ) => {
        resolvedCalls.push([applicationId, containerName, category]);
        return resolvedCount;
      },
    };
    const eventsGateway = {
      emitCrashDiagnosis: (_appId: string, diagnosis: unknown) => {
        emittedDiagnoses.push(diagnosis);
      },
      emitCrashResolved: (_appId: string, payload: unknown) => {
        emittedResolutions.push(payload);
      },
    };

    const service = new EndpointDiagnosisService(
      crashDiagnosesRepository as any,
      eventsGateway as any,
    );

    return {
      service,
      created,
      resolvedCalls,
      emittedDiagnoses,
      emittedResolutions,
      setResolvedCount: (n: number) => (resolvedCount = n),
    };
  };

  it('writes what is wrong, why, and what to do — in that order', async () => {
    const h = build();

    await h.service.record(
      APP,
      'the cluster has no DNS zone assigned and no hostname was declared',
    );

    expect(h.created).toHaveLength(1);
    const diag = h.created[0];
    expect(diag.applicationId).toBe('app-1');
    expect(diag.podName).toEqual(expect.any(String));
    expect(diag.podName).not.toBe('');
    expect(diag.containerName).toBeNull();
    expect(diag.category).toBe(CrashCategory.UNKNOWN);
    expect(diag.severity).toBe(DiagnosisSeverity.CRITICAL);

    // What is wrong.
    expect(diag.title).toMatch(/no endpoint/i);
    expect(diag.title).not.toMatch(/reconciliation/i);

    // Why.
    expect(diag.explanation).toContain(
      'the cluster has no DNS zone assigned and no hostname was declared',
    );

    // What to do.
    const suggestedAction = diag.suggestedAction as {
      type: string;
      message: string;
    };
    expect(suggestedAction.type).toBe(SuggestedActionType.USER_INPUT);
    expect(suggestedAction.message).toMatch(/DNS zone/);
    expect(suggestedAction.message).toMatch(/deploy\.domain\.fqdn/);
    expect(suggestedAction.message).toMatch(/exposure: internal/);

    expect(h.emittedDiagnoses).toHaveLength(1);
  });

  it('resolves an open diagnosis and says so over the same channel a crash resolution uses', async () => {
    const h = build();
    h.setResolvedCount(1);

    await h.service.resolve('app-1');

    expect(h.resolvedCalls).toEqual([['app-1', null, CrashCategory.UNKNOWN]]);
    expect(h.emittedResolutions).toHaveLength(1);
  });

  it('stays quiet when there was nothing open to resolve', async () => {
    const h = build();
    h.setResolvedCount(0);

    await h.service.resolve('app-1');

    expect(h.emittedResolutions).toHaveLength(0);
  });
});
