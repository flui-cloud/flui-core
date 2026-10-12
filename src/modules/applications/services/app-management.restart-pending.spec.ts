jest.mock('@kubernetes/client-node', () => ({}));

import { AppManagementService } from './app-management.service';
import { ENV_HASH_ANNOTATION, envHashOf } from '../utils/env-hash.util';
import { AppEventType } from '../enums/app-event-type.enum';

const PG = { 'flui.cloud/db-engine': 'postgres' };

function service(runningHash: string, snapshot: unknown[] | null) {
  const svc = Object.create(AppManagementService.prototype);
  svc.kubernetesService = {
    getResource: jest.fn(async () => ({
      spec: {
        template: {
          metadata: { annotations: { [ENV_HASH_ANNOTATION]: runningHash } },
        },
      },
    })),
  };
  svc.appRevisionsRepository = {
    findAllEvents: jest.fn(async () => ({
      events: snapshot
        ? [{ eventType: AppEventType.DEPLOY, envSnapshot: snapshot }]
        : [],
    })),
  };
  return (app: unknown) =>
    svc.restartPendingOf(app, 'kc', 'StatefulSet', 'db') as Promise<{
      changes: string[];
    } | null>;
}

describe('whether a database asks for a restart', () => {
  const deployed = [
    { name: 'POSTGRES_PASSWORD', value: 'standby-own', secret: true },
    { name: 'FLUI_PG_STANDBY', value: '1' },
    { name: 'SHARED_BUFFERS', value: '128MB' },
  ];

  it('does not, after a migration rewrote only first-start settings, even with an older hash on the pod', async () => {
    const promoted = {
      labels: PG,
      env: [
        { name: 'POSTGRES_PASSWORD', value: 'adopted', secret: true },
        { name: 'SHARED_BUFFERS', value: '128MB' },
      ],
    };
    const pending = await service(
      envHashOf(deployed as never),
      deployed,
    )(promoted);
    expect(pending).toBeNull();
  });

  it('does, and names it, when a setting the server reads changed', async () => {
    const changed = {
      labels: PG,
      env: [{ name: 'SHARED_BUFFERS', value: '256MB' }],
    };
    const pending = await service('old', deployed)(changed);
    expect(pending?.changes).toEqual(['SHARED_BUFFERS changed']);
  });
});
