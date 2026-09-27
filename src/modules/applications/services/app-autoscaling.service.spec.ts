jest.mock('@kubernetes/client-node', () => ({}));

import { BadRequestException, ConflictException } from '@nestjs/common';
import { ApplicationSourceType } from '../enums/application-source-type.enum';
import { ApplicationEntity } from '../entities/application.entity';
import {
  AppAutoscalingService,
  nextScaling,
  rangeOf,
} from './app-autoscaling.service';

const imageApp = (over: Partial<ApplicationEntity> = {}) =>
  ({
    id: 'a-1',
    slug: 'whoami',
    k8sNamespace: 'user-x',
    clusterId: 'c-1',
    sourceType: ApplicationSourceType.DOCKER_IMAGE,
    workloadKind: 'Deployment',
    scaling: { enabled: false },
    ...over,
  }) as ApplicationEntity;

describe('the replica range an app is given', () => {
  it('turns autoscaling on for an app published from an image', () => {
    const scaling = nextScaling(imageApp(), {
      enabled: true,
      min: 1,
      max: 4,
      targetCPU: 70,
    });
    expect(rangeOf(scaling)).toEqual({
      enabled: true,
      min: 1,
      max: 4,
      targetCPU: 70,
    });
  });

  it('refuses a range that cannot grow', () => {
    expect(() =>
      nextScaling(imageApp(), { enabled: true, min: 3, max: 3 }),
    ).toThrow(BadRequestException);
  });

  it('refuses an app that keeps data on each replica', () => {
    expect(() =>
      nextScaling(imageApp({ workloadKind: 'StatefulSet' }), {
        enabled: true,
        min: 1,
        max: 3,
      }),
    ).toThrow(BadRequestException);
  });

  it('leaves the range of an app deployed from flui.yaml to its manifest', () => {
    const fromRepo = imageApp({
      sourceType: ApplicationSourceType.GIT_BUILD,
      scaling: { enabled: true, minReplicas: 1, maxReplicas: 3 },
    });
    expect(() =>
      nextScaling(fromRepo, { enabled: true, min: 1, max: 5 }),
    ).toThrow(ConflictException);
    expect(
      rangeOf(nextScaling(fromRepo, { enabled: true, targetCPU: 60 })),
    ).toEqual({
      enabled: true,
      min: 1,
      max: 3,
      targetCPU: 60,
    });
  });
});

describe('bringing the cluster to the stored range', () => {
  const make = (app: ApplicationEntity, existing: unknown = null) => {
    const kubernetes = {
      applyManifest: jest.fn().mockResolvedValue([]),
      getResource: jest.fn().mockResolvedValue(existing),
      deleteResource: jest.fn().mockResolvedValue(undefined),
    };
    const applications = {
      findById: jest.fn().mockResolvedValue(app),
      update: jest.fn().mockResolvedValue(app),
    };
    const manifests = {
      autoscalerFor: jest.fn((a: ApplicationEntity) =>
        a.scaling?.enabled
          ? { name: 'whoami-hpa', yaml: 'kind: HorizontalPodAutoscaler' }
          : null,
      ),
    };
    const service = new AppAutoscalingService(
      {
        findOne: jest.fn().mockResolvedValue({ kubeconfigEncrypted: 'x' }),
      } as never,
      applications as never,
      { createAuditEvent: jest.fn().mockResolvedValue(undefined) } as never,
      kubernetes as never,
      { decrypt: () => 'kubeconfig' } as never,
      manifests as never,
    );
    return { service, kubernetes, applications };
  };

  it('applies the autoscaler as soon as the range is set', async () => {
    const { service, kubernetes, applications } = make(imageApp());
    await service.set('a-1', { enabled: true, min: 1, max: 4 });
    expect(applications.update).toHaveBeenCalledWith(
      'a-1',
      expect.objectContaining({
        scaling: expect.objectContaining({
          enabled: true,
          minReplicas: 1,
          maxReplicas: 4,
        }),
      }),
    );
    expect(kubernetes.applyManifest).toHaveBeenCalledWith(
      'kubeconfig',
      'kind: HorizontalPodAutoscaler',
    );
  });

  it('removes the autoscaler left running when autoscaling is turned off', async () => {
    const { service, kubernetes } = make(
      imageApp({ scaling: { enabled: true, minReplicas: 1, maxReplicas: 4 } }),
      { kind: 'HorizontalPodAutoscaler' },
    );
    await service.set('a-1', { enabled: false });
    expect(kubernetes.applyManifest).not.toHaveBeenCalled();
    expect(kubernetes.deleteResource).toHaveBeenCalledWith(
      'kubeconfig',
      'HorizontalPodAutoscaler',
      'whoami-hpa',
      'user-x',
    );
  });
});
