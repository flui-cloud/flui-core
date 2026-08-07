// @kubernetes/client-node@1.x ships as ESM, which jest's default
// transformIgnorePatterns won't transpile. The engine only uses it for types,
// so an empty module is enough.
jest.mock('@kubernetes/client-node', () => ({}));

import type * as k8s from '@kubernetes/client-node';
import { DiagnosticEngineService } from './diagnostic-engine.service';
import { CrashCategory } from '../enums/crash-category.enum';
import { ApplicationEntity } from '../../applications/entities/application.entity';

const app = { id: 'app-1', slug: 'my-app' } as ApplicationEntity;

function buildPod(
  terminated: k8s.V1ContainerStateTerminated,
  overrides: {
    restartCount?: number;
    deletionTimestamp?: Date;
  } = {},
): k8s.V1Pod {
  return {
    metadata: {
      name: 'my-app-abc',
      namespace: 'default',
      deletionTimestamp: overrides.deletionTimestamp,
    },
    status: {
      containerStatuses: [
        {
          name: 'main',
          restartCount: overrides.restartCount ?? 0,
          state: { terminated },
        },
      ],
    },
  } as unknown as k8s.V1Pod;
}

describe('DiagnosticEngineService', () => {
  const createService = () => {
    const getPodLogs = jest.fn().mockResolvedValue('');
    const listPodEvents = jest.fn().mockResolvedValue([]);
    const service = new DiagnosticEngineService(
      { getPodLogs, listPodEvents } as any,
      { match: jest.fn().mockReturnValue(null) } as any,
    );
    return { service, getPodLogs, listPodEvents };
  };

  const analyze = (pod: k8s.V1Pod) =>
    createService().service.analyze({ pod, app, kubeconfig: 'kubeconfig' });

  it('reports OOM_KILLED when the kernel reports OOMKilled', async () => {
    const diagnosis = await analyze(
      buildPod({ reason: 'OOMKilled', exitCode: 137 } as any),
    );

    expect(diagnosis?.category).toBe(CrashCategory.OOM_KILLED);
    expect(diagnosis?.evidence.lastTerminationReason).toBe('OOMKilled');
  });

  it('does not report OOM_KILLED for a bare exit code 137', async () => {
    const diagnosis = await analyze(
      buildPod({ reason: 'Error', exitCode: 137 } as any),
    );

    expect(diagnosis).toBeNull();
  });

  it('does not report OOM_KILLED when a SIGKILLed container has restarted before', async () => {
    const diagnosis = await analyze(
      buildPod({ reason: 'Error', exitCode: 137 } as any, { restartCount: 3 }),
    );

    expect(diagnosis?.category).not.toBe(CrashCategory.OOM_KILLED);
  });

  it('ignores pods that are being drained during a rollout', async () => {
    const diagnosis = await analyze(
      buildPod({ reason: 'OOMKilled', exitCode: 137 } as any, {
        deletionTimestamp: new Date(),
      }),
    );

    expect(diagnosis).toBeNull();
  });
});
