jest.mock('@kubernetes/client-node', () => ({}));

import * as yaml from 'js-yaml';
import { Repository } from 'typeorm';
import {
  DIRECT_IO_ANNOTATION,
  FluiLocalDirectIoReconciler,
  directIoHostScript,
  directIoJobManifest,
  parseDirectIoOutput,
} from './flui-local-direct-io.reconciler';
import { ClusterEntity } from '../entities/cluster.entity';
import { KubernetesService } from '../../shared/services/kubernetes.service';
import { EncryptionService } from '../../../shared/encryption/services/encryption.service';

describe('what a node says about direct I/O on its flui-local loop', () => {
  it('is on once the loop reports it', () => {
    expect(parseDirectIoOutput('noise\nDIO /dev/loop3 1\n')).toEqual({
      kind: 'on',
      device: '/dev/loop3',
    });
  });

  it('is still off when the switch did not take', () => {
    expect(parseDirectIoOutput('DIO /dev/loop3 0')).toEqual({
      kind: 'off',
      device: '/dev/loop3',
    });
  });

  /** A node whose flui-local is a Volume or a plain folder has nothing to switch. */
  it('is not a loop when flui-local sits on something else', () => {
    expect(parseDirectIoOutput('NOTLOOP /dev/sdb')).toEqual({
      kind: 'not-a-loop',
      source: '/dev/sdb',
    });
  });

  it('is unknown when the job printed neither', () => {
    expect(parseDirectIoOutput('losetup: failed').kind).toBe('unknown');
  });
});

describe('the job that switches it on', () => {
  const manifest = yaml.load(directIoJobManifest('job-1', 'lab-worker-2')) as {
    metadata: { namespace: string };
    spec: {
      template: {
        spec: {
          hostPID: boolean;
          nodeSelector: Record<string, string>;
          containers: Array<{
            securityContext: { privileged: boolean };
            args: string[];
          }>;
        };
      };
    };
  };
  const pod = manifest.spec.template.spec;

  it('runs privileged in the host pid namespace on the one node it is for', () => {
    expect(manifest.metadata.namespace).toBe('flui-local-storage');
    expect(pod.hostPID).toBe(true);
    expect(pod.nodeSelector).toEqual({
      'kubernetes.io/hostname': 'lab-worker-2',
    });
    expect(pod.containers[0].securityContext.privileged).toBe(true);
  });

  /** The heredocs only close if their terminators survive the YAML block at column zero. */
  it('carries the host script intact through the YAML block', () => {
    const args = pod.containers[0].args[0];
    expect(args).toContain(directIoHostScript());
    for (const end of ['FLUIPROBE', 'FLUIHELPER', 'FLUIUNIT']) {
      expect(args.split('\n')).toContain(end);
    }
  });

  it('installs the same helper and unit the bootstrap scripts do', () => {
    const script = directIoHostScript();
    expect(script).toContain('/usr/local/sbin/flui-local-direct-io');
    expect(script).toContain('RequiresMountsFor=/var/lib/flui/local');
    expect(script).toContain('systemctl enable flui-local-direct-io.service');
  });
});

describe('switching direct I/O on for nodes that booted without it', () => {
  function setup(
    annotations: Record<string, Record<string, string>>,
    outputs: Record<string, string>,
  ) {
    const annotated: Array<{ node: string; value: string }> = [];
    const kubernetes = {
      listNodeAnnotations: jest.fn(
        async () => new Map(Object.entries(annotations)),
      ),
      addNodeAnnotations: jest.fn(
        async (_k: string, node: string, a: Record<string, string>) => {
          annotated.push({ node, value: a[DIRECT_IO_ANNOTATION] });
        },
      ),
    } as unknown as KubernetesService;
    const clusters = {
      findOne: jest.fn(async () => ({
        id: 'c1',
        name: 'lab',
        kubeconfigEncrypted: 'enc',
      })),
    } as unknown as Repository<ClusterEntity>;
    const encryption = {
      decrypt: () => 'kubeconfig',
    } as unknown as EncryptionService;
    const reconciler = new FluiLocalDirectIoReconciler(
      clusters,
      kubernetes,
      encryption,
    );
    Object.assign(reconciler, {
      runOnNode: jest.fn(async (_k: string, node: string) => {
        const out = outputs[node];
        if (out === undefined) throw new Error('job failed');
        return out;
      }),
    });
    return { reconciler, annotated };
  }

  it('marks a node once its loop is on, and one with no loop as settled', async () => {
    const { reconciler, annotated } = setup(
      { 'lab-master': {}, 'lab-worker-1': {} },
      { 'lab-master': 'DIO /dev/loop3 1', 'lab-worker-1': 'NOTLOOP none' },
    );
    await reconciler.reconcile('c1');
    expect(annotated).toEqual([
      { node: 'lab-master', value: 'on' },
      { node: 'lab-worker-1', value: 'not-a-loop' },
    ]);
  });

  it('runs nothing on a node already marked', async () => {
    const { reconciler, annotated } = setup(
      { 'lab-master': { [DIRECT_IO_ANNOTATION]: 'on' } },
      {},
    );
    expect(await reconciler.reconcile('c1')).toEqual([]);
    expect(annotated).toEqual([]);
  });

  /** Left unmarked, the node is tried again on the next run. */
  it('does not mark a node where the switch failed or did not take', async () => {
    const { reconciler, annotated } = setup(
      { 'lab-master': {}, 'lab-worker-1': {} },
      { 'lab-worker-1': 'DIO /dev/loop3 0' },
    );
    const results = await reconciler.reconcile('c1');
    expect(annotated).toEqual([]);
    expect(results.map((r) => r.state.kind)).toEqual(['unknown', 'off']);
  });
});
