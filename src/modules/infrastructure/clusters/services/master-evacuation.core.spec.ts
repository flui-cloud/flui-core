jest.mock('@kubernetes/client-node', () => ({}));

import type * as k8s from '@kubernetes/client-node';
import { planMasterEvacuation } from './master-evacuation.core';

const parse = {
  parseCpu: (v: string) =>
    v.endsWith('m') ? Number(v.slice(0, -1)) : Number(v) * 1000,
  parseMemory: (v: string) =>
    v.endsWith('Gi')
      ? Number(v.slice(0, -2)) * 1024
      : Number(v.replace('Mi', '')),
};

function node(
  name: string,
  master: boolean,
  extra: Partial<k8s.V1NodeSpec> = {},
): k8s.V1Node {
  return {
    metadata: {
      name,
      labels: master ? { 'node-role.kubernetes.io/control-plane': 'true' } : {},
    },
    spec: master
      ? {
          taints: [
            {
              key: 'node-role.kubernetes.io/control-plane',
              effect: 'NoSchedule',
            },
          ],
        }
      : extra,
    status: {
      allocatable: { cpu: '2', memory: '4Gi' },
      conditions: [{ type: 'Ready', status: 'True' }],
    },
  };
}

function pod(
  name: string,
  on: string,
  opts: {
    memory?: string;
    spec?: Partial<k8s.V1PodSpec>;
    owner?: string | null;
  } = {},
): k8s.V1Pod {
  const owner = opts.owner === undefined ? `${name}-rs` : opts.owner;
  return {
    metadata: {
      name: `${name}-abc`,
      namespace: 'flui-control',
      ownerReferences: owner
        ? [
            {
              kind: 'ReplicaSet',
              name: owner,
              apiVersion: 'apps/v1',
              uid: owner,
            },
          ]
        : [],
    },
    spec: {
      nodeName: on,
      containers: [
        {
          name,
          resources: {
            requests: { cpu: '50m', memory: opts.memory ?? '128Mi' },
          },
        },
      ],
      ...opts.spec,
    },
    status: { phase: 'Running' },
  };
}

function rs(name: string): k8s.V1ReplicaSet {
  return {
    metadata: {
      name: `${name}-rs`,
      namespace: 'flui-control',
      ownerReferences: [
        { kind: 'Deployment', name, apiVersion: 'apps/v1', uid: name },
      ],
    },
  };
}

const nodes = [node('master', true), node('worker-1', false)];

describe('what leaves the master once it is reserved', () => {
  it('moves a deployment that neither tolerates the reservation nor keeps data on the master', () => {
    const plan = planMasterEvacuation({
      nodes,
      pods: [pod('vmsingle', 'master')],
      replicaSets: [rs('vmsingle')],
      parse,
    });

    expect(plan.move).toEqual([
      { namespace: 'flui-control', name: 'vmsingle' },
    ]);
    expect(plan.stays).toEqual([]);
  });

  it('leaves what tolerates the reservation, holds a claim or is not a deployment', () => {
    const plan = planMasterEvacuation({
      nodes,
      pods: [
        pod('flui-api', 'master', {
          spec: {
            tolerations: [
              {
                key: 'node-role.kubernetes.io/control-plane',
                operator: 'Exists',
                effect: 'NoSchedule',
              },
            ],
          },
        }),
        pod('zitadel', 'master', {
          spec: {
            volumes: [
              { name: 'data', persistentVolumeClaim: { claimName: 'z' } },
            ],
          },
        }),
        pod('postgres', 'master', { owner: null }),
        pod('grafana', 'worker-1'),
      ],
      replicaSets: [rs('flui-api'), rs('zitadel'), rs('grafana')],
      parse,
    });

    expect(plan.move).toEqual([]);
  });

  it('keeps on the master what no worker has room for', () => {
    const plan = planMasterEvacuation({
      nodes,
      pods: [
        pod('big', 'master', { memory: '3800Mi' }),
        pod('small', 'master'),
      ],
      replicaSets: [rs('big'), rs('small')],
      parse,
    });

    expect(plan.move).toEqual([{ namespace: 'flui-control', name: 'small' }]);
    expect(plan.stays).toEqual(['flui-control/big']);
  });

  it('moves nothing while every worker is cordoned', () => {
    const plan = planMasterEvacuation({
      nodes: [
        node('master', true),
        node('worker-1', false, { unschedulable: true }),
      ],
      pods: [pod('grafana', 'master')],
      replicaSets: [rs('grafana')],
      parse,
    });

    expect(plan.move).toEqual([]);
    expect(plan.stays).toEqual(['flui-control/grafana']);
  });
});
