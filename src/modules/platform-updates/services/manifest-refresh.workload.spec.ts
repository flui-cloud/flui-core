jest.mock('@kubernetes/client-node', () => ({}));

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NotFoundException } from '@nestjs/common';
import { ManifestRefreshService } from './manifest-refresh.service';
import { InstallValuesService } from './install-values.service';
import { MasterAccessService } from './master-access.service';
import { InstallStateService } from './install-state.service';
import { InstallSourcesService } from './install-sources.service';
import { BootstrapFilesService } from './bootstrap-files.service';
import { HeldFile } from './manifest-master.service';
import { renderManifestFile } from '../utils/manifest-render.util';
import { sha256 } from '../utils/manifest-eligibility.util';

/**
 * The refresh on a workload cluster, against the real templates and indexes:
 * the workload and common sets instead of the control one, and the metrics
 * agent added only where the installer recorded that it deployed it.
 */
const BOOTSTRAP = join(__dirname, '../../../../../bootstrap-scripts/manifests');
const ifTemplates = existsSync(join(BOOTSTRAP, 'workload/INDEX'))
  ? describe
  : describe.skip;
const read = (rel: string): string | null =>
  existsSync(join(BOOTSTRAP, rel))
    ? readFileSync(join(BOOTSTRAP, rel), 'utf8')
    : null;

const WORKLOAD = {
  CLUSTER_ID: 'w-1',
  CLUSTER_NAME: 'workload-cluster-2',
  REMOTE_WRITE_URL: 'http://10.0.0.2:30428/api/v1/write',
};

function realFiles(): BootstrapFilesService {
  const files = new BootstrapFilesService();
  jest
    .spyOn(files, 'text')
    .mockImplementation(async (_ref: string, path: string) =>
      read(path.replace(/^manifests\//, '')),
    );
  return files;
}

function setup(options: {
  monitoring: 'true' | 'false' | 'no-record';
  vmagentOnMaster: boolean;
  liveRemoteWrite?: string;
}) {
  const onDisk = new Map<string, string>();
  for (const name of [
    '00a-traefik-config.yaml',
    '01a-flui-local-storage.yaml',
  ]) {
    onDisk.set(name, read(`common/${name}`) as string);
  }
  if (options.vmagentOnMaster) {
    onDisk.set(
      'vmagent.yaml',
      renderManifestFile(
        'vmagent.yaml',
        read('workload/vmagent.yaml') as string,
        {
          ...WORKLOAD,
          REMOTE_WRITE_URL:
            options.liveRemoteWrite ?? WORKLOAD.REMOTE_WRITE_URL,
        },
      ),
    );
  }

  const master = {
    read: jest.fn(async () => {
      const held = new Map<string, HeldFile>();
      for (const [name, content] of onDisk) {
        held.set(name, { sha: sha256(content), carriesSecret: false, content });
      }
      return held;
    }),
    write: jest.fn(async (_kc: string, _n: string, _p: string, files: any[]) =>
      files.map((f) => f.name),
    ),
  };

  const live: Record<string, any> = {};
  if (options.monitoring !== 'no-record') {
    live['v1/ConfigMap/flui-install-values'] = {
      data: {
        schema: '1',
        bootstrapRef: 'installed-ref',
        clusterType: 'workload',
        'values.json': JSON.stringify({
          ...WORKLOAD,
          DEPLOY_MONITORING_AGENT: options.monitoring,
        }),
        'transforms.json': JSON.stringify({
          raw: ['00a-traefik-config.yaml', '01a-flui-local-storage.yaml'],
        }),
        'rendered.json': '{}',
      },
    };
  }
  if (options.liveRemoteWrite) {
    live['apps/v1/Deployment/vmagent'] = {
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: 'vmagent',
                args: [
                  '-promscrape.config=/config/scrape.yml',
                  `-remoteWrite.url=${options.liveRemoteWrite}`,
                ],
              },
            ],
          },
        },
      },
    };
  }
  const kube = {
    readObject: jest.fn(
      async (_kc: string, apiVersion: string, kind: string, name: string) =>
        live[`${apiVersion}/${kind}/${name}`] ?? null,
    ),
    secretExists: jest.fn(async () => true),
    readSecretData: jest.fn(async () => null),
    createObject: jest.fn(async () => undefined),
    listCrdResources: jest.fn(async () => []),
  };
  const workload = {
    id: WORKLOAD.CLUSTER_ID,
    name: WORKLOAD.CLUSTER_NAME,
    clusterType: 'workload',
    kubeconfigEncrypted: 'enc-w',
    nodes: [{ nodeType: 'master', serverName: 'wk-master' }],
  };
  const control = {
    id: 'c-1',
    name: 'control-cluster',
    clusterType: 'control',
    kubeconfigEncrypted: 'enc-c',
    masterPrivateIp: '10.0.0.2',
    nodes: [{ nodeType: 'master', serverName: 'ctl-master' }],
  };
  const clusters = {
    findOne: jest.fn(async (q: { where: { id?: string } }) => {
      if (q.where.id) return q.where.id === workload.id ? workload : null;
      return control;
    }),
  };
  const files = realFiles();
  const installValues = new InstallValuesService(
    new MasterAccessService(
      clusters as never,
      { decrypt: (v: string) => `kubeconfig-of-${v}` } as never,
    ),
    new InstallStateService(kube as never, clusters as never),
    new InstallSourcesService(files, {
      getManifest: async () => ({ manifest: { releases: [] } }),
    } as never),
    master as never,
  );
  const service = new ManifestRefreshService(
    kube as never,
    master as never,
    {} as never,
    files,
    installValues,
  );
  return { service, installValues, master, kube };
}

ifTemplates('a manifest refresh on a workload cluster', () => {
  it('judges the workload and common sets on that cluster’s master', async () => {
    const { service, master } = setup({
      monitoring: 'true',
      vmagentOnMaster: true,
    });
    const plan = await service.plan({ clusterId: WORKLOAD.CLUSTER_ID });
    const by = Object.fromEntries(plan.entries.map((e) => [e.name, e]));

    expect(plan.clusterId).toBe(WORKLOAD.CLUSTER_ID);
    expect(plan.clusterType).toBe('workload');
    expect(plan.indexed).toBe(true);
    expect(plan.valuesUnavailable).toBeUndefined();
    expect(master.read.mock.calls[0].slice(0, 2)).toEqual([
      'kubeconfig-of-enc-w',
      'wk-master',
    ]);
    expect(Object.keys(by).sort()).toEqual([
      '00a-traefik-config.yaml',
      '01a-flui-local-storage.yaml',
      '02-system-upgrade-controller.yaml',
      'kube-state-metrics.yaml',
      'vmagent.yaml',
    ]);
    expect(by['vmagent.yaml'].action).toBe('unchanged');
    expect(by['kube-state-metrics.yaml'].action).toBe('add');
    expect(by['02-system-upgrade-controller.yaml'].action).toBe('add');
    expect(by['00a-traefik-config.yaml'].action).toBe('unchanged');
  });

  it('never adds the metrics agent where the record says monitoring was not deployed', async () => {
    const { service } = setup({ monitoring: 'false', vmagentOnMaster: false });
    const plan = await service.plan({ clusterId: WORKLOAD.CLUSTER_ID });
    const by = Object.fromEntries(plan.entries.map((e) => [e.name, e]));

    for (const name of ['vmagent.yaml', 'kube-state-metrics.yaml']) {
      expect(by[name].action).toBe('skip');
      expect(by[name].reason).toMatch(/DEPLOY_MONITORING_AGENT/);
    }
    expect(by['02-system-upgrade-controller.yaml'].action).toBe('add');
  });

  it('never adds it without a record either', async () => {
    const { service } = setup({
      monitoring: 'no-record',
      vmagentOnMaster: false,
    });
    const plan = await service.plan({ clusterId: WORKLOAD.CLUSTER_ID });
    const by = Object.fromEntries(plan.entries.map((e) => [e.name, e]));

    expect(plan.valuesUnavailable).toMatch(/no record/);
    expect(by['vmagent.yaml'].action).toBe('skip');
    expect(by['vmagent.yaml'].reason).toMatch(/DEPLOY_MONITORING_AGENT/);
    expect(by['kube-state-metrics.yaml'].action).toBe('skip');
  });

  it('proves the push address the agent was moved to since the install', async () => {
    const moved = 'http://10.1.0.9:30428/api/v1/write';
    const { service } = setup({
      monitoring: 'true',
      vmagentOnMaster: true,
      liveRemoteWrite: moved,
    });
    const plan = await service.plan({ clusterId: WORKLOAD.CLUSTER_ID });
    const vmagent = plan.entries.find((e) => e.name === 'vmagent.yaml');
    expect(vmagent?.action).toBe('unchanged');
  });

  it('writes to the workload master only what it previewed there', async () => {
    const { service, master } = setup({
      monitoring: 'true',
      vmagentOnMaster: true,
    });
    const { planId } = await service.plan({ clusterId: WORKLOAD.CLUSTER_ID });
    await expect(service.apply({ planId })).rejects.toThrow(/plan changed/);
    const result = await service.apply({
      planId,
      clusterId: WORKLOAD.CLUSTER_ID,
    });
    expect(master.write.mock.calls[0][1]).toBe('wk-master');
    expect(result.wrote.sort()).toEqual([
      '02-system-upgrade-controller.yaml',
      'kube-state-metrics.yaml',
    ]);
  });

  it('refuses a cluster it does not know', async () => {
    const { service } = setup({ monitoring: 'true', vmagentOnMaster: true });
    await expect(
      service.plan({ clusterId: '00000000-0000-0000-0000-000000000000' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reconstructs a workload record with the agent it found and where it pushes', async () => {
    const { installValues, kube } = setup({
      monitoring: 'no-record',
      vmagentOnMaster: true,
    });
    const plan = await installValues.plan(WORKLOAD.CLUSTER_ID);
    expect(plan.clusterType).toBe('workload');
    expect(plan.files.find((f) => f.name === 'vmagent.yaml')?.proven).toBe(
      true,
    );
    expect(plan.values).toMatchObject({
      ...WORKLOAD,
      DEPLOY_MONITORING_AGENT: 'true',
    });

    await installValues.apply(plan.planId, WORKLOAD.CLUSTER_ID);
    const record = (kube.createObject as jest.Mock).mock.calls[0][1];
    expect(record.data.clusterType).toBe('workload');
    expect(JSON.parse(record.data['values.json'])).toMatchObject({
      DEPLOY_MONITORING_AGENT: 'true',
    });
  });

  it('records the agent as absent when the master has none', async () => {
    const { installValues } = setup({
      monitoring: 'no-record',
      vmagentOnMaster: false,
    });
    const plan = await installValues.plan(WORKLOAD.CLUSTER_ID);
    expect(plan.values.DEPLOY_MONITORING_AGENT).toBe('false');
  });
});
