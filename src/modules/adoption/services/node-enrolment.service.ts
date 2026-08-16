import { Injectable, Logger } from '@nestjs/common';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import {
  assertPublicKey,
  buildEnrolmentJob,
  jobName,
} from './node-enrolment.manifest';

export interface EnrolmentTarget {
  nodeName: string;
}

export interface EnrolmentResult {
  nodeName: string;
  succeeded: boolean;
  detail: string;
}

const NAMESPACE = 'flui-system';
const JOB_TIMEOUT_MS = 180_000;

/**
 * Writes a certificate authority's public key onto the nodes themselves.
 *
 * This is the step that cannot use SSH, because SSH is the thing being switched
 * on: a cluster from the managed path has an empty `trusted_user_ca_keys` and
 * no authorised key, so there is no shell to run the enrolment from. What it
 * does have is a Kubernetes API, and a pod can reach the host filesystem. So
 * the cluster enrols itself, once, on its own nodes.
 *
 * The script is deliberately additive. It writes one new file and appends at
 * most one line to `sshd_config`, never removing or rewriting what is there —
 * on a host reached only over SSH, a cleanup that goes wrong is unrecoverable,
 * and there is nothing here worth that risk.
 */
@Injectable()
export class NodeEnrolmentService {
  private readonly logger = new Logger(NodeEnrolmentService.name);

  constructor(private readonly kubernetes: KubernetesService) {}

  async enrolAll(
    kubeconfig: string,
    caPublicKey: string,
    targets: readonly EnrolmentTarget[],
  ): Promise<EnrolmentResult[]> {
    assertPublicKey(caPublicKey);

    const results: EnrolmentResult[] = [];
    for (const target of targets) {
      results.push(
        await this.enrolOne(kubeconfig, caPublicKey, target.nodeName),
      );
    }
    return results;
  }

  private async enrolOne(
    kubeconfig: string,
    caPublicKey: string,
    nodeName: string,
  ): Promise<EnrolmentResult> {
    const { batchApi } = this.kubernetes.getKubeClient(kubeconfig);
    const name = jobName(nodeName);

    try {
      await batchApi.deleteNamespacedJob({
        name,
        namespace: NAMESPACE,
        propagationPolicy: 'Background',
      });
    } catch {
      // Absent is the normal case; this only clears a previous attempt.
    }

    try {
      await batchApi.createNamespacedJob({
        namespace: NAMESPACE,
        body: buildEnrolmentJob(nodeName, caPublicKey) as never,
      });
    } catch (error) {
      return {
        nodeName,
        succeeded: false,
        detail: `Could not start the enrolment job: ${messageOf(error)}`,
      };
    }

    return this.waitForJob(batchApi, name, nodeName);
  }

  private async waitForJob(
    batchApi: {
      readNamespacedJob: (a: {
        name: string;
        namespace: string;
      }) => Promise<any>;
    },
    name: string,
    nodeName: string,
  ): Promise<EnrolmentResult> {
    const deadline = Date.now() + JOB_TIMEOUT_MS;

    while (Date.now() < deadline) {
      await sleep(3000);
      let job: any;
      try {
        job = await batchApi.readNamespacedJob({ name, namespace: NAMESPACE });
      } catch (error) {
        return { nodeName, succeeded: false, detail: messageOf(error) };
      }

      const status = job?.status ?? {};
      if (status.succeeded) {
        return {
          nodeName,
          succeeded: true,
          detail: 'Certificate authority enrolled.',
        };
      }
      if (status.failed) {
        return {
          nodeName,
          succeeded: false,
          detail:
            'The enrolment job failed on this node. Its logs are in the flui-system namespace.',
        };
      }
    }

    return {
      nodeName,
      succeeded: false,
      detail:
        'The enrolment job did not finish in time; it may still be running.',
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
