import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { dump } from 'js-yaml';
import { randomBytes } from 'node:crypto';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import {
  InfrastructureOperationEntity,
  OperationStep,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import {
  DbPodExecService,
  ResolvedApp,
} from '../../db-lifecycle/services/db-pod-exec.service';
import { DbWriteFenceService } from '../../db-lifecycle/services/db-write-fence.service';
import { DbFenceRecord } from '../../db-lifecycle/entities/db-migration.entity';
import { CnpgOperatorInstallerService } from './cnpg-operator-installer.service';
import { HaActivationPorts } from './postgres-ha-activation.runner';
import { CNPG_API_VERSION } from '../postgres-ha.constants';

const STEP_PROGRESS: Partial<Record<OperationStep, number>> = {
  [OperationStep.DB_HA_PREPARE]: 5,
  [OperationStep.DB_HA_COPY]: 20,
  [OperationStep.DB_HA_FENCE]: 80,
  [OperationStep.DB_HA_PROMOTE]: 90,
  [OperationStep.DB_HA_SWITCH]: 95,
};

export interface PortsTarget {
  app: ApplicationEntity;
  kubeconfig: string;
  source: ResolvedApp;
  operationId: string;
}

/** The cluster side of the move, for one database. */
@Injectable()
export class PostgresHaPortsAdapter {
  constructor(
    @InjectRepository(ApplicationEntity)
    private readonly apps: Repository<ApplicationEntity>,
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operations: Repository<InfrastructureOperationEntity>,
    private readonly kubernetes: KubernetesService,
    private readonly exec: DbPodExecService,
    private readonly fences: DbWriteFenceService,
    private readonly installer: CnpgOperatorInstallerService,
  ) {}

  portsFor(target: PortsTarget): HaActivationPorts {
    const { app, kubeconfig, source, operationId } = target;
    const namespace = app.k8sNamespace;
    let fence: DbFenceRecord | null = null;
    const persistFence = async (record: DbFenceRecord) => {
      fence = record;
      const op = await this.operations.findOne({ where: { id: operationId } });
      await this.operations.update(operationId, {
        metadata: {
          ...op?.metadata,
          fence: record,
        } as InfrastructureOperationEntity['metadata'],
      });
    };
    const clusterObject = (name: string) =>
      this.kubernetes.readObject(
        kubeconfig,
        CNPG_API_VERSION,
        'Cluster',
        name,
        namespace,
      );

    return {
      ensureOperator: () => this.installer.ensureInstalled(kubeconfig),
      sourceSql: (sql) => this.exec.execSql(source, sql),
      sourceShell: (script) => this.exec.execRaw(source, script),
      fenceSource: async () => {
        await this.fences.fence(
          source,
          `flui:fence:ha${randomBytes(4).toString('hex')}`,
          persistFence,
        );
      },
      unfenceSource: async () => {
        if (fence) await this.fences.unfence(source, fence);
      },
      apply: async (objects) => {
        await this.kubernetes.serverSideApply(
          kubeconfig,
          objects.map((o) => dump(o)).join('---\n'),
        );
      },
      readyInstances: async (name) =>
        Number((await clusterObject(name))?.status?.readyInstances ?? 0),
      primaryPod: async (name) =>
        (await clusterObject(name))?.status?.currentPrimary ?? null,
      clusterSql: (pod, sql) =>
        this.kubernetes.execInPod(
          kubeconfig,
          namespace,
          '',
          'postgres',
          ['psql', '-U', 'postgres', '-Atc', sql],
          pod,
        ),
      patchCluster: (name, patch) =>
        this.kubernetes.mergePatchObject(kubeconfig, {
          apiVersion: CNPG_API_VERSION,
          kind: 'Cluster',
          metadata: { name, namespace },
          ...patch,
        }),
      patchAppService: async (patch) => {
        const { metadata, ...rest } = patch as {
          metadata?: Record<string, unknown>;
        };
        await this.kubernetes.mergePatchObject(kubeconfig, {
          apiVersion: 'v1',
          kind: 'Service',
          metadata: { name: `${app.slug}-svc`, namespace, ...metadata },
          ...rest,
        });
        if (app.pooler?.enabled && app.pooler.upstream?.mode !== 'forward') {
          await this.kubernetes.mergePatchObject(kubeconfig, {
            apiVersion: 'v1',
            kind: 'Service',
            metadata: { name: `${app.slug}-pooler-upstream`, namespace },
            ...rest,
          });
        }
      },
      scaleSingleInstance: (replicas) =>
        this.kubernetes.scaleWorkload(
          kubeconfig,
          'StatefulSet',
          namespace,
          app.slug,
          replicas,
        ),
      superuserPassword: async () => {
        if (source.pgUser !== 'postgres') return null;
        const sts = await this.kubernetes.readObject(
          kubeconfig,
          'apps/v1',
          'StatefulSet',
          app.slug,
          namespace,
        );
        const ref = (
          sts?.spec?.template?.spec?.containers?.[0]?.env ?? []
        ).find((e: { name: string }) => e.name === 'POSTGRES_PASSWORD')
          ?.valueFrom?.secretKeyRef as
          | { name: string; key: string }
          | undefined;
        if (!ref) return null;
        const secret = await this.kubernetes.readObject(
          kubeconfig,
          'v1',
          'Secret',
          ref.name,
          namespace,
        );
        const value = secret?.data?.[ref.key];
        return value ? Buffer.from(value, 'base64').toString('utf8') : null;
      },
      saveState: async (spec) => {
        await this.apps.update(app.id, { databaseHa: spec });
      },
      progress: async (step) => {
        await this.operations.update(operationId, {
          currentStep: step,
          progress: STEP_PROGRESS[step] ?? 0,
        });
      },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => new Date(),
    };
  }
}
