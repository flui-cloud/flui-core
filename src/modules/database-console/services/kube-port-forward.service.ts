import { Injectable, Logger } from '@nestjs/common';
import * as net from 'node:net';
import * as k8s from '@kubernetes/client-node';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';

export interface PortForwardTunnel {
  /** Loopback port a TCP client (e.g. a pg.Pool) connects to. */
  localPort: number;
  dispose: () => Promise<void>;
}

/**
 * Opens a raw TCP tunnel from a loopback port on this process to an in-cluster
 * pod, via the Kubernetes apiserver `portforward` subresource. This is the only
 * way the control-plane backend can speak the Postgres wire protocol to a DB
 * running on a workload cluster (the apiserver's HTTP service-proxy cannot carry
 * arbitrary TCP). Reachability is inherited from the patched kubeconfig server,
 * exactly like exec/apply.
 */
@Injectable()
export class KubePortForwardService {
  private readonly logger = new Logger(KubePortForwardService.name);

  constructor(private readonly kubernetesService: KubernetesService) {}

  async open(
    kubeconfig: string,
    namespace: string,
    podLabelSelector: string,
    targetPort: number,
  ): Promise<PortForwardTunnel> {
    const kc = this.kubernetesService.makeKubeConfig(kubeconfig);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const pods = await coreApi.listNamespacedPod({
      namespace,
      labelSelector: podLabelSelector,
    });
    const pod = (pods.items ?? []).find((p) => p.status?.phase === 'Running');
    if (!pod?.metadata?.name) {
      throw new Error(
        `No running pod for selector "${podLabelSelector}" in namespace "${namespace}"`,
      );
    }
    const podName = pod.metadata.name;

    const pf = new k8s.PortForward(kc, true);
    const sockets = new Set<net.Socket>();

    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => socket.destroy());
      // The incoming socket is both the sink (pod->client) and the source
      // (client->pod) of the forwarded stream.
      pf.portForward(
        namespace,
        podName,
        [targetPort],
        socket,
        socket,
        socket,
      ).catch((err) => {
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `port-forward stream error for ${podName}:${targetPort}: ${reason}`,
        );
        socket.destroy();
      });
    });

    const localPort = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') resolve(addr.port);
        else reject(new Error('failed to bind loopback port for port-forward'));
      });
    });

    this.logger.log(
      `port-forward open: 127.0.0.1:${localPort} -> ${namespace}/${podName}:${targetPort}`,
    );

    const dispose = async (): Promise<void> => {
      for (const s of sockets) s.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      this.logger.log(
        `port-forward closed: 127.0.0.1:${localPort} -> ${namespace}/${podName}:${targetPort}`,
      );
    };

    return { localPort, dispose };
  }
}
