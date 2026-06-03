import { Injectable, Logger } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { Writable } from 'node:stream';

export interface ContainerResources {
  cpu: string | null;
  memory: string | null;
}

export interface ContainerDetail {
  name: string;
  image: string;
  requests: ContainerResources;
  limits: ContainerResources;
}

export interface ReplicaInfo {
  desired?: number;
  ready?: number;
  available?: number;
  unavailable?: number;
  updated?: number;
}

export interface ResourceDetail {
  replicas: ReplicaInfo;
  containers: ContainerDetail[];
}

export interface ContainerMetrics {
  name: string;
  usage: { cpu: string; memory: string };
}

export interface PodMetrics {
  name: string;
  containers: ContainerMetrics[];
}

@Injectable()
export class KubernetesService {
  private readonly logger = new Logger(KubernetesService.name);

  /**
   * Public wrapper to expose a patched KubeConfig instance.
   * Use this when you need to instantiate k8s client classes directly
   * (e.g. k8s.Log for log streaming) rather than through getKubeClient().
   */
  makeKubeConfig(kubeconfigContent: string): k8s.KubeConfig {
    return this.loadKubeconfig(kubeconfigContent);
  }

  /**
   * Patch the kubeconfig server URL using KUBECONFIG_SERVER_OVERRIDE env var,
   * then load it into a KubeConfig instance.
   * All public methods that accept a kubeconfig string go through this helper
   * so the patch is applied exactly once regardless of which service calls us.
   */
  private loadKubeconfig(kubeconfigContent: string): k8s.KubeConfig {
    const kc = new k8s.KubeConfig();
    kc.loadFromString(this.patchKubeconfigServer(kubeconfigContent));
    return kc;
  }

  /**
   * Get Kubernetes client from kubeconfig string
   */
  getKubeClient(kubeconfigContent: string): {
    coreApi: k8s.CoreV1Api;
    appsApi: k8s.AppsV1Api;
    batchApi: k8s.BatchV1Api;
    networkingApi: k8s.NetworkingV1Api;
  } {
    const kc = this.loadKubeconfig(kubeconfigContent);

    return {
      coreApi: kc.makeApiClient(k8s.CoreV1Api),
      appsApi: kc.makeApiClient(k8s.AppsV1Api),
      batchApi: kc.makeApiClient(k8s.BatchV1Api),
      networkingApi: kc.makeApiClient(k8s.NetworkingV1Api),
    };
  }

  /**
   * Canonicalize a parsed spec into the exact JSON string that will be stored
   * on K8s under `metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"]`.
   *
   * MUTATES `spec`: ensures `metadata.annotations` exists (possibly as {}) and
   * strips any pre-existing last-applied-configuration key before serializing.
   * The returned string is the canonical form that drift detection will hash —
   * both sides (apply-time and reconcile-time) must produce identical bytes.
   *
   * Keep this the single source of truth — do not inline this logic elsewhere.
   */
  buildLastAppliedConfiguration(spec: any): string {
    spec.metadata = spec.metadata || {};
    spec.metadata.annotations = spec.metadata.annotations || {};
    delete spec.metadata.annotations[
      'kubectl.kubernetes.io/last-applied-configuration'
    ];
    return JSON.stringify(spec);
  }

  /**
   * Apply manifest from YAML string
   * Supports multiple documents separated by ---
   */
  async applyManifest(
    kubeconfigContent: string,
    manifestYaml: string,
  ): Promise<any[]> {
    const kc = this.loadKubeconfig(kubeconfigContent);

    const client = k8s.KubernetesObjectApi.makeApiClient(kc);
    const specs = k8s.loadAllYaml(manifestYaml);
    const results = [];

    for (const spec of specs) {
      // Skip empty documents
      if (!spec || Object.keys(spec).length === 0) {
        continue;
      }

      // Stamp the canonical last-applied-configuration annotation. The string
      // written here must byte-match what the deploy processor hashes as
      // desiredHash — centralized via buildLastAppliedConfiguration().
      const lastApplied = this.buildLastAppliedConfiguration(spec);
      spec.metadata.annotations[
        'kubectl.kubernetes.io/last-applied-configuration'
      ] = lastApplied;

      try {
        // Try to create the resource
        const createResponse = await client.create(spec);
        this.logger.log(
          `Created ${spec.kind}/${spec.metadata?.name} in namespace ${spec.metadata?.namespace || 'default'}`,
        );
        results.push(createResponse.body);
      } catch (error) {
        // If resource already exists, patch it
        // Use MergePatch because CRDs (e.g. cert-manager ClusterIssuer) do not
        // support the default StrategicMergePatch content type.
        if (this.httpCode(error) === 409) {
          const patchResponse = await client.patch(
            spec,
            undefined,
            undefined,
            undefined,
            undefined,
            k8s.PatchStrategy.MergePatch,
          );
          this.logger.log(
            `Patched ${spec.kind}/${spec.metadata?.name} in namespace ${spec.metadata?.namespace || 'default'}`,
          );
          results.push(patchResponse.body);
        } else {
          this.logger.error(
            `Failed to apply ${spec.kind}/${spec.metadata?.name}: ${error.message}`,
          );
          throw error;
        }
      }
    }

    return results;
  }

  /**
   * Replace a manifest using HTTP PUT (full replace — removes keys not in payload).
   * Creates the resource if it doesn't exist yet.
   */
  async replaceManifest(
    kubeconfigContent: string,
    manifestYaml: string,
  ): Promise<any[]> {
    const kc = this.loadKubeconfig(kubeconfigContent);

    const client = k8s.KubernetesObjectApi.makeApiClient(kc);
    const specs = k8s.loadAllYaml(manifestYaml);
    const results = [];

    for (const spec of specs) {
      if (!spec || Object.keys(spec).length === 0) continue;

      spec.metadata = spec.metadata || {};

      try {
        // Fetch existing resource to get the resourceVersion (required for replace)
        const existingRaw = await client.read(spec);
        const existingObj: any = (existingRaw as any).body ?? existingRaw;
        spec.metadata.resourceVersion = existingObj?.metadata?.resourceVersion;
        const replaceRaw = await client.replace(spec);
        const replaceObj: any = replaceRaw.body ?? replaceRaw;
        this.logger.log(
          `Replaced ${spec.kind}/${spec.metadata?.name} in namespace ${spec.metadata?.namespace || 'default'}`,
        );
        results.push(replaceObj);
      } catch (error) {
        if (this.httpCode(error) === 404) {
          // Resource doesn't exist yet — create it
          const createResponse = await client.create(spec);
          this.logger.log(
            `Created ${spec.kind}/${spec.metadata?.name} in namespace ${spec.metadata?.namespace || 'default'}`,
          );
          results.push(createResponse.body);
        } else {
          this.logger.error(
            `Failed to replace ${spec.kind}/${spec.metadata?.name}: ${error.message}`,
          );
          throw error;
        }
      }
    }

    return results;
  }

  /**
   * Delete a Kubernetes resource
   */
  async deleteResource(
    kubeconfigContent: string,
    kind: string,
    name: string,
    namespace: string = 'default',
  ): Promise<void> {
    const kc = this.loadKubeconfig(kubeconfigContent);

    const client = k8s.KubernetesObjectApi.makeApiClient(kc);

    try {
      await client.delete({
        apiVersion: this.getApiVersionForKind(kind),
        kind,
        metadata: { name, namespace },
      });
      this.logger.log(`Deleted ${kind}/${name} in namespace ${namespace}`);
    } catch (error) {
      if (this.httpCode(error) === 404) {
        this.logger.warn(`${kind}/${name} not found, skipping deletion`);
      } else {
        this.logger.error(`Failed to delete ${kind}/${name}: ${error.message}`);
        throw error;
      }
    }
  }

  /**
   * Get a Kubernetes resource
   */
  async getResource(
    kubeconfigContent: string,
    kind: string,
    name: string,
    namespace: string = 'default',
  ): Promise<any> {
    const kc = this.loadKubeconfig(kubeconfigContent);

    const client = k8s.KubernetesObjectApi.makeApiClient(kc);

    try {
      const response = await client.read({
        apiVersion: this.getApiVersionForKind(kind),
        kind,
        metadata: { name, namespace },
      });
      return response;
    } catch (error) {
      if (this.httpCode(error) === 404) {
        return null;
      }
      this.logger.error(`Failed to get ${kind}/${name}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Wait for a resource to be ready
   */
  async waitForReady(
    kubeconfigContent: string,
    kind: string,
    name: string,
    namespace: string = 'default',
    timeoutMs: number = 300000, // 5 minutes default
  ): Promise<boolean> {
    const startTime = Date.now();
    const pollInterval = 5000; // 5 seconds

    while (Date.now() - startTime < timeoutMs) {
      try {
        const resource = await this.getResource(
          kubeconfigContent,
          kind,
          name,
          namespace,
        );

        if (!resource) {
          this.logger.debug(`${kind}/${name} not found yet, waiting...`);
          await this.sleep(pollInterval);
          continue;
        }

        const isReady = this.checkResourceReady(kind, resource);
        if (isReady) {
          this.logger.log(`${kind}/${name} is ready`);
          return true;
        }

        this.logger.debug(`${kind}/${name} not ready yet, waiting...`);
        await this.sleep(pollInterval);
      } catch (error) {
        this.logger.error(
          `Error checking ${kind}/${name} readiness: ${error.message}`,
        );
        await this.sleep(pollInterval);
      }
    }

    throw new Error(
      `Timeout waiting for ${kind}/${name} to be ready after ${timeoutMs}ms`,
    );
  }

  /**
   * Get pod logs
   */
  async getPodLogs(
    kubeconfigContent: string,
    podName: string,
    namespace: string = 'default',
    containerName?: string,
    tailLines?: number,
  ): Promise<string> {
    const { coreApi } = this.getKubeClient(kubeconfigContent);

    try {
      const response = await coreApi.readNamespacedPodLog({
        name: podName,
        namespace,
        container: containerName,
        tailLines,
      });
      return response as unknown as string;
    } catch (error) {
      this.logger.error(`Failed to get logs for ${podName}: ${error.message}`);
      throw error;
    }
  }

  /**
   * List resources by kind and namespace
   */
  async listResources(
    kubeconfigContent: string,
    kind: string,
    namespace: string = 'default',
    labelSelector?: string,
  ): Promise<any[]> {
    const { coreApi, appsApi, batchApi } =
      this.getKubeClient(kubeconfigContent);

    try {
      let response;

      switch (kind.toLowerCase()) {
        case 'pod':
        case 'pods':
          response = await coreApi.listNamespacedPod({
            namespace,
            labelSelector,
          });
          break;
        case 'service':
        case 'services':
          response = await coreApi.listNamespacedService({
            namespace,
            labelSelector,
          });
          break;
        case 'deployment':
        case 'deployments':
          response = await appsApi.listNamespacedDeployment({
            namespace,
            labelSelector,
          });
          break;
        case 'statefulset':
        case 'statefulsets':
          response = await appsApi.listNamespacedStatefulSet({
            namespace,
            labelSelector,
          });
          break;
        case 'configmap':
        case 'configmaps':
          response = await coreApi.listNamespacedConfigMap({
            namespace,
            labelSelector,
          });
          break;
        case 'secret':
        case 'secrets':
          response = await coreApi.listNamespacedSecret({
            namespace,
            labelSelector,
          });
          break;
        case 'persistentvolumeclaim':
        case 'persistentvolumeclaims':
          response = await coreApi.listNamespacedPersistentVolumeClaim({
            namespace,
            labelSelector,
          });
          break;
        case 'job':
        case 'jobs':
          response = await batchApi.listNamespacedJob({
            namespace,
            labelSelector,
          });
          break;
        default:
          throw new Error(`Unsupported resource kind: ${kind}`);
      }

      return response.items ?? response.body?.items ?? [];
    } catch (error) {
      this.logger.error(`Failed to list ${kind}: ${error.message}`);
      throw error;
    }
  }

  /**
   * List CRD resources (cert-manager Challenges, Orders, etc.) via KubernetesObjectApi.
   */
  async listCrdResources(
    kubeconfigContent: string,
    kind: string,
    namespace?: string,
  ): Promise<any[]> {
    const kc = this.loadKubeconfig(kubeconfigContent);
    const client = k8s.KubernetesObjectApi.makeApiClient(kc);

    try {
      const apiVersion = this.getApiVersionForKind(kind);
      const response = await client.list(apiVersion, kind, namespace);
      const body = (response as any).body ?? response;
      return body.items ?? [];
    } catch (error) {
      this.logger.error(
        `Failed to list CRD ${kind} in ${namespace ?? 'all namespaces'}: ${error.message}`,
      );
      return [];
    }
  }

  async listResourcesByLabel(
    kubeconfigContent: string,
    kind: string,
    namespace: string,
    labelSelector: string,
  ): Promise<any[]> {
    const kc = this.loadKubeconfig(kubeconfigContent);
    const client = k8s.KubernetesObjectApi.makeApiClient(kc);
    const apiVersion = this.getApiVersionForKind(kind);

    try {
      const response = await client.list(
        apiVersion,
        kind,
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        labelSelector,
      );
      const body = (response as any).body ?? response;
      return body.items ?? [];
    } catch (error) {
      const code = this.httpCode(error);
      if (code === 404) return [];
      this.logger.warn(
        `listResourcesByLabel ${kind} (${labelSelector}) in ${namespace} failed: ${error.message}`,
      );
      return [];
    }
  }

  /**
   * Get resource details including container specs (requests/limits) and replica info.
   * Returns structured data for Deployment, StatefulSet, DaemonSet.
   */
  async getResourceDetail(
    kubeconfigContent: string,
    kind: string,
    name: string,
    namespace: string = 'default',
  ): Promise<ResourceDetail | null> {
    const resource = await this.getResource(
      kubeconfigContent,
      kind,
      name,
      namespace,
    );
    if (!resource) return null;

    const detail: ResourceDetail = {
      replicas: {},
      containers: [],
    };

    switch (kind) {
      case 'Deployment':
      case 'StatefulSet': {
        detail.replicas = {
          desired: resource.spec?.replicas ?? 0,
          ready: resource.status?.readyReplicas ?? 0,
          available: resource.status?.availableReplicas ?? 0,
          unavailable: resource.status?.unavailableReplicas ?? 0,
          updated: resource.status?.updatedReplicas ?? 0,
        };
        break;
      }
      case 'DaemonSet': {
        detail.replicas = {
          desired: resource.status?.desiredNumberScheduled ?? 0,
          ready: resource.status?.numberReady ?? 0,
          available: resource.status?.numberAvailable ?? 0,
          unavailable: resource.status?.numberUnavailable ?? 0,
          updated: resource.status?.updatedNumberScheduled ?? 0,
        };
        break;
      }
    }

    const containers =
      resource.spec?.template?.spec?.containers ||
      resource.spec?.containers ||
      [];
    for (const c of containers) {
      detail.containers.push({
        name: c.name,
        image: c.image || '',
        requests: {
          cpu: c.resources?.requests?.cpu || null,
          memory: c.resources?.requests?.memory || null,
        },
        limits: {
          cpu: c.resources?.limits?.cpu || null,
          memory: c.resources?.limits?.memory || null,
        },
      });
    }

    return detail;
  }

  /**
   * Get pod-level CPU/memory usage from the Metrics API (metrics.k8s.io).
   * Requires metrics-server to be installed on the cluster.
   */
  async getPodMetrics(
    kubeconfigContent: string,
    namespace: string = 'default',
    labelSelector?: string,
  ): Promise<PodMetrics[]> {
    const kc = this.loadKubeconfig(kubeconfigContent);

    const metricsClient = new k8s.Metrics(kc);

    try {
      const metricsResponse = await metricsClient.getPodMetrics(namespace);
      let pods = metricsResponse.items || [];

      if (labelSelector) {
        const { coreApi } = this.getKubeClient(kubeconfigContent);
        const podList = await coreApi.listNamespacedPod({
          namespace,
          labelSelector,
        });
        const matchingNames = new Set(
          podList.items.map((p) => p.metadata?.name),
        );
        pods = pods.filter((p) => matchingNames.has(p.metadata?.name));
      }

      return pods.map((pod) => ({
        name: pod.metadata?.name || '',
        containers: (pod.containers || []).map((c) => ({
          name: c.name,
          usage: {
            cpu: c.usage?.cpu || '0',
            memory: c.usage?.memory || '0',
          },
        })),
      }));
    } catch (error) {
      if (this.httpCode(error) === 404 || error.message?.includes('metrics')) {
        this.logger.warn(
          'Metrics API not available (metrics-server may not be installed)',
        );
        return [];
      }
      this.logger.error(`Failed to get pod metrics: ${error.message}`);
      return [];
    }
  }

  /**
   * Read a single pod as V1Pod. Returns null if not found.
   */
  async readPod(
    kubeconfigContent: string,
    namespace: string,
    podName: string,
  ): Promise<k8s.V1Pod | null> {
    const { coreApi } = this.getKubeClient(kubeconfigContent);
    try {
      return await coreApi.readNamespacedPod({ name: podName, namespace });
    } catch (error) {
      if (this.httpCode(error) === 404) return null;
      throw error;
    }
  }

  /**
   * List pods matching a label selector.
   */
  async listPodsByLabel(
    kubeconfigContent: string,
    namespace: string,
    labelSelector: string,
  ): Promise<k8s.V1Pod[]> {
    const { coreApi } = this.getKubeClient(kubeconfigContent);
    const response = await coreApi.listNamespacedPod({
      namespace,
      labelSelector,
    });
    return response.items ?? [];
  }

  /**
   * List events that reference the given pod (involvedObject.name filter).
   */
  async listPodEvents(
    kubeconfigContent: string,
    namespace: string,
    podName: string,
  ): Promise<k8s.CoreV1Event[]> {
    const { coreApi } = this.getKubeClient(kubeconfigContent);
    const response = await coreApi.listNamespacedEvent({
      namespace,
      fieldSelector: `involvedObject.name=${podName}`,
    });
    return response.items ?? [];
  }

  /**
   * Check whether a Secret exists in the namespace.
   */
  async checkSecretExists(
    kubeconfigContent: string,
    namespace: string,
    name: string,
  ): Promise<boolean> {
    const { coreApi } = this.getKubeClient(kubeconfigContent);
    try {
      await coreApi.readNamespacedSecret({ name, namespace });
      return true;
    } catch (error) {
      if (this.httpCode(error) === 404) return false;
      throw error;
    }
  }

  /**
   * Check whether a ConfigMap exists in the namespace.
   */
  async checkConfigMapExists(
    kubeconfigContent: string,
    namespace: string,
    name: string,
  ): Promise<boolean> {
    const { coreApi } = this.getKubeClient(kubeconfigContent);
    try {
      await coreApi.readNamespacedConfigMap({ name, namespace });
      return true;
    } catch (error) {
      if (this.httpCode(error) === 404) return false;
      throw error;
    }
  }

  /**
   * Watch pod events in a namespace filtered by label selector. Uses the
   * Kubernetes Watch API — events are delivered as they happen.
   *
   * Call `abortController.abort()` to stop the watch.
   */
  async watchPodEvents(
    kubeconfigContent: string,
    namespace: string,
    labelSelector: string,
    onEvent: (type: string, pod: k8s.V1Pod) => void | Promise<void>,
    abortController: AbortController,
  ): Promise<void> {
    const kc = this.loadKubeconfig(kubeconfigContent);
    const watch = new k8s.Watch(kc);

    const path = `/api/v1/namespaces/${namespace}/pods`;
    const req = await watch.watch(
      path,
      { labelSelector },
      (type: string, obj: k8s.V1Pod) => {
        try {
          const result = onEvent(type, obj);
          if (result instanceof Promise) {
            result.catch((err) =>
              this.logger.error(`watchPodEvents onEvent error: ${err.message}`),
            );
          }
        } catch (err) {
          this.logger.error(
            `watchPodEvents onEvent error: ${(err as Error).message}`,
          );
        }
      },
      (err) => {
        if (err && !abortController.signal.aborted) {
          this.logger.warn(
            `Pod watch closed with error in ${namespace}: ${err.message}`,
          );
        }
      },
    );

    abortController.signal.addEventListener('abort', () => {
      try {
        (req as { abort: () => void }).abort();
      } catch {
        /* noop */
      }
    });
  }

  /**
   * Discover which ConfigMaps and Secrets a workload uses via envFrom and env[].valueFrom.
   * Returns deduplicated lists of names.
   * Falls back to empty lists if the workload does not exist yet.
   */
  async getWorkloadEnvSources(
    kubeconfigContent: string,
    name: string,
    namespace: string = 'default',
    kind: string = 'Deployment',
  ): Promise<{ configMaps: string[]; secrets: string[] }> {
    const workload = await this.getResource(
      kubeconfigContent,
      kind,
      name,
      namespace,
    );
    if (!workload) {
      return { configMaps: [], secrets: [] };
    }

    const containers: any[] = workload.spec?.template?.spec?.containers ?? [];
    const configMapSet = new Set<string>();
    const secretSet = new Set<string>();

    for (const container of containers) {
      for (const source of container.envFrom ?? []) {
        if (source.configMapRef?.name)
          configMapSet.add(source.configMapRef.name);
        if (source.secretRef?.name) secretSet.add(source.secretRef.name);
      }
      for (const envVar of container.env ?? []) {
        if (envVar.valueFrom?.configMapKeyRef?.name)
          configMapSet.add(envVar.valueFrom.configMapKeyRef.name);
        if (envVar.valueFrom?.secretKeyRef?.name)
          secretSet.add(envVar.valueFrom.secretKeyRef.name);
      }
    }

    return {
      configMaps: Array.from(configMapSet),
      secrets: Array.from(secretSet),
    };
  }

  /**
   * Execute a command in a pod and return stdout.
   * Finds the first running pod matching the label selector.
   */
  async execInPod(
    kubeconfigContent: string,
    namespace: string,
    labelSelector: string,
    containerName: string,
    command: string[],
  ): Promise<string> {
    const kc = this.loadKubeconfig(kubeconfigContent);

    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const pods = await coreApi.listNamespacedPod({ namespace, labelSelector });
    const pod = (pods.items ?? []).find((p) => p.status?.phase === 'Running');
    if (!pod?.metadata?.name) {
      throw new Error(
        `No running pod found with selector "${labelSelector}" in namespace "${namespace}"`,
      );
    }

    const exec = new k8s.Exec(kc);
    return new Promise<string>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      const stdoutStream = new Writable({
        write(chunk, _enc, cb) {
          stdout += chunk.toString();
          cb();
        },
      });
      const stderrStream = new Writable({
        write(chunk, _enc, cb) {
          stderr += chunk.toString();
          cb();
        },
      });
      exec
        .exec(
          namespace,
          pod.metadata.name,
          containerName,
          command,
          stdoutStream,
          stderrStream,
          null,
          false,
          (status) => {
            if (status?.status === 'Success') {
              resolve(stdout);
            } else {
              reject(
                new Error(
                  `exec failed: ${status?.message ?? stderr ?? 'unknown error'}`,
                ),
              );
            }
          },
        )
        .catch(reject);
    });
  }

  /**
   * Patch a Kubernetes Secret with new stringData entries.
   */
  async patchSecret(
    kubeconfigContent: string,
    namespace: string,
    name: string,
    stringData: Record<string, string>,
  ): Promise<void> {
    // Build a Secret manifest and use server-side apply (applyManifest) to avoid
    // content-type issues with the generated k8s client (defaults to json-patch+json).
    const entries = Object.entries(stringData)
      .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
      .join('\n');

    const manifest = [
      'apiVersion: v1',
      'kind: Secret',
      'metadata:',
      `  name: ${name}`,
      `  namespace: ${namespace}`,
      'stringData:',
      entries,
    ].join('\n');

    await this.applyManifest(kubeconfigContent, manifest);
    this.logger.log(`Secret ${name} patched in namespace ${namespace}`);
  }

  /**
   * Trigger a rolling restart of a Deployment by patching the pod template annotation.
   * Equivalent to `kubectl rollout restart deployment/<name>`.
   */
  /**
   * Trigger a rolling restart of a Deployment by patching the pod template annotation.
   * Equivalent to `kubectl rollout restart deployment/<name>`.
   */
  async restartDeployment(
    kubeconfigContent: string,
    namespace: string,
    name: string,
  ): Promise<void> {
    const kc = this.loadKubeconfig(kubeconfigContent);
    const client = k8s.KubernetesObjectApi.makeApiClient(kc);

    const patch: k8s.V1Deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name, namespace },
      spec: {
        template: {
          metadata: {
            annotations: {
              'kubectl.kubernetes.io/restartedAt': new Date().toISOString(),
            },
          },
        },
      } as unknown as k8s.V1DeploymentSpec,
    };

    await client.patch(
      patch,
      undefined,
      undefined,
      'flui-api',
      undefined,
      k8s.PatchStrategy.StrategicMergePatch,
    );
    this.logger.log(
      `Deployment ${name} restart triggered in namespace ${namespace}`,
    );
  }

  /**
   * Equivalent to `kubectl set image deployment/<name> <container>=<image> -n <ns>`.
   * Strategic merge patch only replaces the image of the named container,
   * leaving init containers, sidecars and other spec fields untouched.
   */
  async patchDeploymentContainerImage(
    kubeconfigContent: string,
    namespace: string,
    deploymentName: string,
    containerName: string,
    newImage: string,
  ): Promise<void> {
    const kc = this.loadKubeconfig(kubeconfigContent);
    const client = k8s.KubernetesObjectApi.makeApiClient(kc);

    const patch: k8s.V1Deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: deploymentName, namespace },
      spec: {
        template: {
          spec: {
            containers: [{ name: containerName, image: newImage }],
          },
        },
      } as unknown as k8s.V1DeploymentSpec,
    };

    await client.patch(
      patch,
      undefined,
      undefined,
      'flui-api',
      undefined,
      k8s.PatchStrategy.StrategicMergePatch,
    );
    this.logger.log(
      `Deployment ${deploymentName} container ${containerName} image set to ${newImage} in namespace ${namespace}`,
    );
  }

  /**
   * Read the current image of a container in a Deployment.
   * Returns null if the deployment, container, or image is missing.
   */
  async getDeploymentContainerImage(
    kubeconfigContent: string,
    namespace: string,
    deploymentName: string,
    containerName: string,
  ): Promise<string | null> {
    const kc = this.loadKubeconfig(kubeconfigContent);
    const appsApi = kc.makeApiClient(k8s.AppsV1Api);
    try {
      const dep = await appsApi.readNamespacedDeployment({
        name: deploymentName,
        namespace,
      });
      const containers = dep.spec?.template?.spec?.containers ?? [];
      const c = containers.find((x) => x.name === containerName);
      return c?.image ?? null;
    } catch (err) {
      if (this.httpCode(err) === 404) return null;
      throw err;
    }
  }

  /**
   * Read a file from a PVC by running a temporary busybox pod.
   * The pod is deleted automatically after reading.
   * Use this for distroless containers that don't have shell utilities.
   */
  async readPvcFile(
    kubeconfigContent: string,
    namespace: string,
    pvcName: string,
    filePath: string,
  ): Promise<string> {
    const kc = this.loadKubeconfig(kubeconfigContent);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);

    const podName = `pvc-reader-${Date.now()}`;
    const podManifest: k8s.V1Pod = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: podName, namespace },
      spec: {
        restartPolicy: 'Never',
        enableServiceLinks: false,
        // Use rancher-mirrored busybox — already cached on every K3s node, no pull needed
        volumes: [
          { name: 'pvc', persistentVolumeClaim: { claimName: pvcName } },
        ],
        containers: [
          {
            name: 'reader',
            image: 'rancher/mirrored-library-busybox:1.36.1',
            command: ['cat', filePath],
            volumeMounts: [{ name: 'pvc', mountPath: '/pvc' }],
          },
        ],
      },
    };

    try {
      await coreApi.createNamespacedPod({ namespace, body: podManifest });

      // Wait for pod to complete (max 60s)
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        const pod = await coreApi.readNamespacedPod({
          name: podName,
          namespace,
        });
        const phase = pod.status?.phase;
        if (phase === 'Succeeded') break;
        if (phase === 'Failed') throw new Error(`Reader pod failed`);
        await this.sleep(2000);
      }

      // Read logs = stdout of cat command
      const logs = await coreApi.readNamespacedPodLog({
        name: podName,
        namespace,
        container: 'reader',
      });
      return typeof logs === 'string' ? logs : ((logs as any).body ?? '');
    } finally {
      await coreApi
        .deleteNamespacedPod({ name: podName, namespace })
        .catch(() => {});
    }
  }

  /** @deprecated Use getWorkloadEnvSources with kind='Deployment' */
  async getDeploymentEnvSources(
    kubeconfigContent: string,
    deploymentName: string,
    namespace: string = 'default',
  ): Promise<{ configMaps: string[]; secrets: string[] }> {
    return this.getWorkloadEnvSources(
      kubeconfigContent,
      deploymentName,
      namespace,
      'Deployment',
    );
  }

  /**
   * Ensure a Kubernetes namespace exists, creating it if needed.
   * Idempotent — safe to call before every deploy.
   */
  async ensureNamespaceExists(
    kubeconfigContent: string,
    namespace: string,
    labels: Record<string, string> = {},
  ): Promise<void> {
    const { coreApi } = this.getKubeClient(kubeconfigContent);

    try {
      await coreApi.readNamespace({ name: namespace });
      this.logger.debug(`Namespace ${namespace} already exists`);
    } catch (error) {
      if (this.httpCode(error) !== 404) {
        throw error;
      }

      await coreApi.createNamespace({
        body: {
          apiVersion: 'v1',
          kind: 'Namespace',
          metadata: {
            name: namespace,
            labels: {
              'managed-by': 'flui-cloud',
              ...labels,
            },
          },
        },
      });
      this.logger.log(`Namespace ${namespace} created`);
    }
  }

  // Helper methods

  private getApiVersionForKind(kind: string): string {
    const apiVersionMap: Record<string, string> = {
      Pod: 'v1',
      Service: 'v1',
      ConfigMap: 'v1',
      Secret: 'v1',
      PersistentVolumeClaim: 'v1',
      Namespace: 'v1',
      Deployment: 'apps/v1',
      StatefulSet: 'apps/v1',
      DaemonSet: 'apps/v1',
      Job: 'batch/v1',
      CronJob: 'batch/v1',
      Ingress: 'networking.k8s.io/v1',
      IngressRoute: 'traefik.containo.us/v1alpha1',
      Certificate: 'cert-manager.io/v1',
      CertificateRequest: 'cert-manager.io/v1',
      ClusterIssuer: 'cert-manager.io/v1',
      Issuer: 'cert-manager.io/v1',
      Challenge: 'acme.cert-manager.io/v1',
      Order: 'acme.cert-manager.io/v1',
      ServiceAccount: 'v1',
      ClusterRole: 'rbac.authorization.k8s.io/v1',
      ClusterRoleBinding: 'rbac.authorization.k8s.io/v1',
      MutatingWebhookConfiguration: 'admissionregistration.k8s.io/v1',
      ValidatingWebhookConfiguration: 'admissionregistration.k8s.io/v1',
      Role: 'rbac.authorization.k8s.io/v1',
      RoleBinding: 'rbac.authorization.k8s.io/v1',
      APIService: 'apiregistration.k8s.io/v1',
      Backup: 'velero.io/v1',
      Restore: 'velero.io/v1',
      BackupStorageLocation: 'velero.io/v1',
      VolumeSnapshotLocation: 'velero.io/v1',
      Schedule: 'velero.io/v1',
      PodVolumeBackup: 'velero.io/v1',
      PodVolumeRestore: 'velero.io/v1',
    };

    return apiVersionMap[kind] || 'v1';
  }

  private checkResourceReady(kind: string, resource: any): boolean {
    switch (kind) {
      case 'Pod':
        return resource.status?.phase === 'Running';
      case 'Deployment':
      case 'StatefulSet': {
        const desired = resource.spec?.replicas ?? 0;
        const ready = resource.status?.readyReplicas ?? 0;
        const current = resource.status?.replicas ?? 0;
        const updated = resource.status?.updatedReplicas ?? 0;
        const available = resource.status?.availableReplicas ?? 0;
        const observedGen = resource.status?.observedGeneration ?? 0;
        const generation = resource.metadata?.generation ?? 0;
        if (desired === 0) return current === 0;
        return (
          observedGen >= generation &&
          updated === desired &&
          ready === desired &&
          available === desired &&
          current === updated
        );
      }
      case 'Job':
        return resource.status?.succeeded > 0;
      case 'Service':
        // Services are ready when they have endpoints (for LoadBalancer, check external IP)
        if (resource.spec?.type === 'LoadBalancer') {
          return resource.status?.loadBalancer?.ingress?.length > 0;
        }
        return true; // ClusterIP and NodePort are immediately ready
      default:
        // For unknown types, assume ready if status exists
        return !!resource.status;
    }
  }

  /**
   * Rewrite the kubeconfig server URL if KUBECONFIG_SERVER_OVERRIDE is set.
   *
   * When the API runs inside the cluster the bootstrap seeder replaces
   * 127.0.0.1 with kubernetes.default.svc so that in-cluster DNS resolves it.
   * In local development that address is unreachable.
   *
   * Set KUBECONFIG_SERVER_OVERRIDE=https://<MASTER_IP>:6443 in .env to have
   * every kubeconfig transparently rewritten before use.
   *
   * Example .env:
   *   KUBECONFIG_SERVER_OVERRIDE=https://1.2.3.4:6443
   */
  patchKubeconfigServer(kubeconfig: string): string {
    const override = process.env.KUBECONFIG_SERVER_OVERRIDE;
    if (!override) {
      return kubeconfig;
    }
    return kubeconfig.replaceAll(
      /server:\s*https?:\/\/[^\s]+/g,
      `server: ${override}`,
    );
  }

  /**
   * Normalises the HTTP status code from a @kubernetes/client-node error.
   * v1.x uses `error.code`; older versions used `error.statusCode`.
   */
  private httpCode(error: any): number | undefined {
    return error?.code ?? error?.statusCode;
  }

  /**
   * Poll until a Secret exists and is readable in the cluster.
   * Resolves as soon as the Secret is confirmed readable; throws on timeout.
   * Use this to guard operations that depend on a Secret being visible to
   * other controllers (e.g. cert-manager reading hetzner-secret before the
   * ClusterIssuer is applied).
   */
  async waitForSecret(
    kubeconfigContent: string,
    name: string,
    namespace: string,
    timeoutMs: number = 30000,
  ): Promise<void> {
    const { coreApi } = this.getKubeClient(kubeconfigContent);
    const POLL_INTERVAL_MS = 2000;
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      try {
        await coreApi.readNamespacedSecret({ name, namespace });
        this.logger.log(`Secret ${namespace}/${name} is ready`);
        return;
      } catch (error) {
        if (this.httpCode(error) === 404) {
          this.logger.debug(
            `Secret ${namespace}/${name} not found yet, retrying...`,
          );
          await this.sleep(POLL_INTERVAL_MS);
          continue;
        }
        throw error;
      }
    }

    throw new Error(
      `Secret ${namespace}/${name} not ready after ${timeoutMs}ms`,
    );
  }

  /**
   * Returns true if the Secret exists in the cluster, false if not found.
   */
  async secretExists(
    kubeconfigContent: string,
    name: string,
    namespace: string,
  ): Promise<boolean> {
    const { coreApi } = this.getKubeClient(kubeconfigContent);
    try {
      await coreApi.readNamespacedSecret({ name, namespace });
      return true;
    } catch (error) {
      if (this.httpCode(error) === 404) {
        return false;
      }
      throw error;
    }
  }

  // ─── Cluster resource capacity ───────────────────────────────────────────────

  /**
   * Sum allocatable CPU (millicores) and memory (Mi) across all READY nodes.
   * Uses node.status.allocatable which reflects what is schedulable after
   * OS and kubelet reserved resources.
   */
  async getNodeAllocatable(
    kubeconfigContent: string,
  ): Promise<{ cpu: number; memory: number }> {
    const { coreApi } = this.getKubeClient(kubeconfigContent);
    const nodes = await coreApi.listNode();
    let totalCpu = 0;
    let totalMemory = 0;

    for (const node of nodes.items ?? []) {
      // Only count nodes that are Ready
      const readyCondition = (node.status?.conditions ?? []).find(
        (c) => c.type === 'Ready',
      );
      if (readyCondition?.status !== 'True') continue;

      const allocatable = node.status?.allocatable ?? {};
      totalCpu += this.parseCpu(allocatable['cpu'] ?? '0');
      totalMemory += this.parseMemory(allocatable['memory'] ?? '0');
    }

    return { cpu: totalCpu, memory: totalMemory };
  }

  /**
   * Poll the Kubernetes API until the named node reports Ready=True or the
   * timeout expires. Used after a scale-node action (power_on) to confirm the
   * node rejoined the cluster.
   */
  async waitForNodeReady(
    kubeconfigContent: string,
    nodeName: string,
    timeoutMs = 300000,
    intervalMs = 5000,
  ): Promise<void> {
    const { coreApi } = this.getKubeClient(kubeconfigContent);
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const node = await coreApi.readNode({ name: nodeName });
        const ready = (node.status?.conditions ?? []).find(
          (c) => c.type === 'Ready',
        );
        if (ready?.status === 'True') return;
      } catch (err) {
        if (this.httpCode(err) !== 404) {
          this.logger.warn(
            `waitForNodeReady poll error on ${nodeName}: ${(err as Error).message}`,
          );
        }
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(
      `Node ${nodeName} did not reach Ready=True within ${Math.round(timeoutMs / 1000)}s`,
    );
  }

  /**
   * Mark a node unschedulable. Existing pods continue to run; new ones are
   * not placed on it. Used as a precaution before power-cycling a node during
   * scale-node operations.
   */
  async cordonNode(kubeconfigContent: string, nodeName: string): Promise<void> {
    await this.setNodeUnschedulable(kubeconfigContent, nodeName, true);
  }

  async uncordonNode(
    kubeconfigContent: string,
    nodeName: string,
  ): Promise<void> {
    await this.setNodeUnschedulable(kubeconfigContent, nodeName, false);
  }

  private async setNodeUnschedulable(
    kubeconfigContent: string,
    nodeName: string,
    unschedulable: boolean,
  ): Promise<void> {
    const kc = this.loadKubeconfig(kubeconfigContent);
    const client = k8s.KubernetesObjectApi.makeApiClient(kc);
    const patch = {
      apiVersion: 'v1',
      kind: 'Node',
      metadata: { name: nodeName },
      spec: { unschedulable },
    } as k8s.KubernetesObject;
    await client.patch(
      patch,
      undefined,
      undefined,
      'flui-api',
      undefined,
      k8s.PatchStrategy.MergePatch,
    );
  }

  /**
   * Add/remove the control-plane NoSchedule taint on master node(s) via the
   * k8s API. Returns false when no control-plane node is found.
   */
  async setControlPlaneTaint(
    kubeconfigContent: string,
    apply: boolean,
  ): Promise<boolean> {
    const key = 'node-role.kubernetes.io/control-plane';
    const { coreApi } = this.getKubeClient(kubeconfigContent);
    const nodes = await coreApi.listNode();
    const masters = (nodes.items ?? []).filter((n) => {
      const labels = n.metadata?.labels ?? {};
      return (
        'node-role.kubernetes.io/control-plane' in labels ||
        'node-role.kubernetes.io/master' in labels
      );
    });
    if (masters.length === 0) return false;

    const kc = this.loadKubeconfig(kubeconfigContent);
    const client = k8s.KubernetesObjectApi.makeApiClient(kc);
    for (const node of masters) {
      const name = node.metadata?.name;
      if (!name) continue;
      const without = (node.spec?.taints ?? []).filter((t) => t.key !== key);
      const taints = apply
        ? [...without, { key, effect: 'NoSchedule' }]
        : without;
      const patch = {
        apiVersion: 'v1',
        kind: 'Node',
        metadata: { name },
        spec: { taints },
      } as k8s.KubernetesObject;
      await client.patch(
        patch,
        undefined,
        undefined,
        'flui-api',
        undefined,
        k8s.PatchStrategy.MergePatch,
      );
    }
    return true;
  }

  /**
   * Sum resource requests (CPU in millicores, memory in Mi) across all
   * containers in Running pods across all namespaces.
   */
  async getPodResourceRequests(
    kubeconfigContent: string,
  ): Promise<{ cpu: number; memory: number }> {
    const { coreApi } = this.getKubeClient(kubeconfigContent);
    const pods = await coreApi.listPodForAllNamespaces();
    let totalCpu = 0;
    let totalMemory = 0;

    for (const pod of pods.items ?? []) {
      if (pod.status?.phase !== 'Running') continue;
      for (const container of pod.spec?.containers ?? []) {
        const requests = container.resources?.requests ?? {};
        totalCpu += this.parseCpu(requests['cpu'] ?? '0');
        totalMemory += this.parseMemory(requests['memory'] ?? '0');
      }
    }

    return { cpu: totalCpu, memory: totalMemory };
  }

  /**
   * Returns allocatable and currently-requested resources on the master
   * (control-plane) node. Used to gate scheduling of pods that are pinned
   * to the master via `persistenceScope=dedicated`. CPU in millicores, memory in Mi.
   */
  async getMasterNodeCapacity(kubeconfigContent: string): Promise<{
    nodeName: string;
    allocatable: { cpu: number; memory: number };
    requested: { cpu: number; memory: number };
  } | null> {
    const { coreApi } = this.getKubeClient(kubeconfigContent);
    const nodes = await coreApi.listNode();
    const master = (nodes.items ?? []).find((n) => {
      const labels = n.metadata?.labels ?? {};
      return (
        labels['node-role.kubernetes.io/control-plane'] === 'true' ||
        labels['node-role.kubernetes.io/master'] === 'true' ||
        'node-role.kubernetes.io/control-plane' in labels ||
        'node-role.kubernetes.io/master' in labels
      );
    });
    if (!master) return null;
    return this.getNodeCapacityByName(
      kubeconfigContent,
      master.metadata?.name ?? '',
    );
  }

  /**
   * Allocatable + currently-requested resources on a specific node by name.
   * Returns null if the node is not found. Used by placement prechecks for
   * `persistenceScope=dedicated` apps that may target the master or a
   * specific worker.
   */
  async getNodeCapacityByName(
    kubeconfigContent: string,
    nodeName: string,
  ): Promise<{
    nodeName: string;
    allocatable: { cpu: number; memory: number };
    requested: { cpu: number; memory: number };
  } | null> {
    if (!nodeName) return null;
    const { coreApi } = this.getKubeClient(kubeconfigContent);
    const nodes = await coreApi.listNode();
    const node = (nodes.items ?? []).find((n) => n.metadata?.name === nodeName);
    if (!node) return null;

    const alloc = node.status?.allocatable ?? {};
    const allocatable = {
      cpu: this.parseCpu(alloc['cpu'] ?? '0'),
      memory: this.parseMemory(alloc['memory'] ?? '0'),
    };

    const pods = await coreApi.listPodForAllNamespaces();
    let cpuReq = 0;
    let memReq = 0;
    for (const pod of pods.items ?? []) {
      if (pod.spec?.nodeName !== nodeName) continue;
      const phase = pod.status?.phase;
      if (phase !== 'Running' && phase !== 'Pending') continue;
      for (const container of pod.spec?.containers ?? []) {
        const requests = container.resources?.requests ?? {};
        cpuReq += this.parseCpu(requests['cpu'] ?? '0');
        memReq += this.parseMemory(requests['memory'] ?? '0');
      }
    }
    return {
      nodeName,
      allocatable,
      requested: { cpu: cpuReq, memory: memReq },
    };
  }

  /**
   * Allocatable, requested and free resources for every READY worker node
   * (nodes without the control-plane/master label). CPU in millicores, mem Mi.
   */
  async listWorkerNodeCapacities(kubeconfigContent: string): Promise<
    Array<{
      nodeName: string;
      allocatable: { cpu: number; memory: number };
      requested: { cpu: number; memory: number };
      free: { cpu: number; memory: number };
    }>
  > {
    const { coreApi } = this.getKubeClient(kubeconfigContent);
    const nodes = await coreApi.listNode();
    const pods = await coreApi.listPodForAllNamespaces();

    return (nodes.items ?? [])
      .filter((n) => this.isReadyWorker(n))
      .map((node) => {
        const nodeName = node.metadata?.name ?? '';
        const alloc = node.status?.allocatable ?? {};
        const allocatable = {
          cpu: this.parseCpu(alloc['cpu'] ?? '0'),
          memory: this.parseMemory(alloc['memory'] ?? '0'),
        };
        const requested = this.sumPodRequestsOnNode(pods.items ?? [], nodeName);
        return {
          nodeName,
          allocatable,
          requested,
          free: {
            cpu: allocatable.cpu - requested.cpu,
            memory: allocatable.memory - requested.memory,
          },
        };
      });
  }

  private isReadyWorker(node: k8s.V1Node): boolean {
    const labels = node.metadata?.labels ?? {};
    if (
      'node-role.kubernetes.io/control-plane' in labels ||
      'node-role.kubernetes.io/master' in labels
    ) {
      return false;
    }
    if (!node.metadata?.name) return false;
    const ready = (node.status?.conditions ?? []).find(
      (c) => c.type === 'Ready',
    );
    return ready?.status === 'True';
  }

  private sumPodRequestsOnNode(
    pods: k8s.V1Pod[],
    nodeName: string,
  ): { cpu: number; memory: number } {
    let cpu = 0;
    let memory = 0;
    for (const pod of pods) {
      if (pod.spec?.nodeName !== nodeName) continue;
      const phase = pod.status?.phase;
      if (phase !== 'Running' && phase !== 'Pending') continue;
      for (const container of pod.spec?.containers ?? []) {
        const requests = container.resources?.requests ?? {};
        cpu += this.parseCpu(requests['cpu'] ?? '0');
        memory += this.parseMemory(requests['memory'] ?? '0');
      }
    }
    return { cpu, memory };
  }

  /**
   * Parse a Kubernetes CPU string to millicores.
   * Examples: "250m" → 250, "2" → 2000, "0.5" → 500
   */
  parseCpu(value: string): number {
    if (!value) return 0;
    if (value.endsWith('m')) {
      return Number.parseInt(value.slice(0, -1), 10) || 0;
    }
    return Math.round((Number.parseFloat(value) || 0) * 1000);
  }

  /**
   * Parse a Kubernetes memory string to mebibytes (Mi).
   * Examples: "512Mi" → 512, "1Gi" → 1024, "1073741824" → 1024 (bytes)
   */
  parseMemory(value: string): number {
    if (!value) return 0;
    if (value.endsWith('Ki'))
      return Math.round(Number.parseInt(value, 10) / 1024);
    if (value.endsWith('Mi')) return Number.parseInt(value, 10) || 0;
    if (value.endsWith('Gi'))
      return Math.round((Number.parseFloat(value) || 0) * 1024);
    if (value.endsWith('Ti'))
      return Math.round((Number.parseFloat(value) || 0) * 1024 * 1024);
    if (value.endsWith('K'))
      return Math.round(Number.parseInt(value, 10) / 1024);
    if (value.endsWith('M')) return Number.parseInt(value, 10) || 0;
    if (value.endsWith('G'))
      return Math.round((Number.parseFloat(value) || 0) * 954); // 1e9 / 1048576
    // Plain bytes
    return Math.round((Number.parseInt(value, 10) || 0) / (1024 * 1024));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
