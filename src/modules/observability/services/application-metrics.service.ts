import { Injectable, Logger } from '@nestjs/common';
import { PrometheusQueryService } from './prometheus-query.service';
import { ApplicationService } from '../../applications/services/application.service';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { AppResourcesRepository } from '../../applications/repositories/app-resources.repository';
import { ApplicationResourceKind } from '../../applications/enums/application-resource-kind.enum';
import {
  PrometheusInstantQueryResponse,
  PrometheusRangeQueryResponse,
} from '../interfaces/prometheus-response.interface';
import {
  AppMetricsDto,
  AppMetricsDataPointDto,
  AppMetricsHistoryDto,
  AppPodPhaseDto,
  ReplicaMetricsDto,
  ReplicaMetricsDataPointDto,
  AppHealthStatusDto,
  AppVolumeMetricsDto,
} from '../dto/application-metrics.dto';

/** Maps ApplicationResourceKind workload values to kube-state-metrics label keys */
const WORKLOAD_LABEL_KEY: Record<string, string> = {
  Deployment: 'deployment',
  StatefulSet: 'statefulset',
  DaemonSet: 'daemonset',
};

/**
 * Application Metrics Service
 *
 * Queries pre-computed flui:* recording rules from Prometheus
 * to provide application-level metrics (CPU, memory, network, status, pods).
 *
 * Recording rules use two label patterns:
 * - Pod-level (CPU, memory, network, restart, pods): namespace + label_app_kubernetes_io_name
 * - Workload-level (replicas, up, ready_ratio): namespace + <deployment|statefulset|daemonset>
 */
@Injectable()
export class ApplicationMetricsService {
  private readonly logger = new Logger(ApplicationMetricsService.name);

  constructor(
    private readonly prometheusQuery: PrometheusQueryService,
    private readonly applicationService: ApplicationService,
    private readonly appResourcesRepository: AppResourcesRepository,
  ) {}

  /**
   * Get instant metrics for a single application
   */
  async getAppMetricsInstant(
    appId: string,
    appName: string,
    namespace: string,
  ): Promise<AppMetricsDto> {
    const podFilter = this.buildPodLabelFilter(appName, namespace);
    const app = await this.applicationService.findById(appId);
    const workloadLabelKey = await this.resolveWorkloadLabelKey(appId);
    const deplFilter = this.buildWorkloadLabelFilter(
      appName,
      namespace,
      workloadLabelKey,
    );

    const [
      cpuUsageRes,
      cpuRequestsRes,
      cpuLimitsRes,
      cpuUtilRes,
      memUsageRes,
      memRequestsRes,
      memLimitsRes,
      memUtilRes,
      netRxRes,
      netTxRes,
      replicasDesiredRes,
      replicasReadyRes,
      replicasUnavailRes,
      readyRatioRes,
      appUpRes,
      restartTotalRes,
      restartRateRes,
      podsByPhaseRes,
      cpuUsageByPodRes,
      cpuRequestsByPodRes,
      cpuLimitsByPodRes,
      cpuUtilByPodRes,
      memUsageByPodRes,
      memRequestsByPodRes,
      memLimitsByPodRes,
      memUtilByPodRes,
      netRxByPodRes,
      netTxByPodRes,
      restartByPodRes,
      restartRateByPodRes,
      podReadyByPodRes,
      podPhaseByPodRes,
    ] = await Promise.all([
      this.prometheusQuery.queryInstant(
        `flui:app_cpu_usage_cores{${podFilter}}`,
      ),
      this.prometheusQuery.queryInstant(
        `flui:app_cpu_requests_cores{${podFilter}}`,
      ),
      this.prometheusQuery.queryInstant(
        `flui:app_cpu_limits_cores{${podFilter}}`,
      ),
      this.prometheusQuery.queryInstant(
        `flui:app_cpu_utilization_percent{${podFilter}}`,
      ),
      this.prometheusQuery.queryInstant(
        `flui:app_memory_usage_bytes{${podFilter}}`,
      ),
      this.prometheusQuery.queryInstant(
        `flui:app_memory_requests_bytes{${podFilter}}`,
      ),
      this.prometheusQuery.queryInstant(
        `flui:app_memory_limits_bytes{${podFilter}}`,
      ),
      this.prometheusQuery.queryInstant(
        `flui:app_memory_utilization_percent{${podFilter}}`,
      ),
      this.prometheusQuery.queryInstant(
        `flui:app_network_receive_bytes_rate{${podFilter}}`,
      ),
      this.prometheusQuery.queryInstant(
        `flui:app_network_transmit_bytes_rate{${podFilter}}`,
      ),
      this.prometheusQuery.queryInstant(
        `flui:app_replicas_desired{${deplFilter}}`,
      ),
      this.prometheusQuery.queryInstant(
        `flui:app_replicas_ready{${deplFilter}}`,
      ),
      this.prometheusQuery.queryInstant(
        `flui:app_replicas_unavailable{${deplFilter}}`,
      ),
      this.prometheusQuery.queryInstant(
        `flui:app_status_ready_ratio{${deplFilter}}`,
      ),
      this.prometheusQuery.queryInstant(`flui:app_up{${deplFilter}}`),
      this.prometheusQuery.queryInstant(`flui:app_restart_total{${podFilter}}`),
      this.prometheusQuery.queryInstant(
        `flui:app_restart_rate_1h{${podFilter}}`,
      ),
      this.prometheusQuery.queryInstant(`flui:app_pods_by_phase{${podFilter}}`),
      // Per-replica queries (recording rules that preserve the `pod` label)
      this.prometheusQuery.queryInstant(
        `flui:app_cpu_usage_cores_by_pod{${podFilter}}`,
      ),
      this.prometheusQuery.queryInstant(
        `flui:app_cpu_requests_cores_by_pod{${podFilter}}`,
      ),
      this.prometheusQuery.queryInstant(
        `flui:app_cpu_limits_cores_by_pod{${podFilter}}`,
      ),
      this.prometheusQuery.queryInstant(
        `flui:app_cpu_utilization_percent_by_pod{${podFilter}}`,
      ),
      this.prometheusQuery.queryInstant(
        `flui:app_memory_usage_bytes_by_pod{${podFilter}}`,
      ),
      this.prometheusQuery.queryInstant(
        `flui:app_memory_requests_bytes_by_pod{${podFilter}}`,
      ),
      this.prometheusQuery.queryInstant(
        `flui:app_memory_limits_bytes_by_pod{${podFilter}}`,
      ),
      this.prometheusQuery.queryInstant(
        `flui:app_memory_utilization_percent_by_pod{${podFilter}}`,
      ),
      this.prometheusQuery.queryInstant(
        `flui:app_network_receive_bytes_rate_by_pod{${podFilter}}`,
      ),
      this.prometheusQuery.queryInstant(
        `flui:app_network_transmit_bytes_rate_by_pod{${podFilter}}`,
      ),
      this.prometheusQuery.queryInstant(
        `flui:app_restart_total_by_pod{${podFilter}}`,
      ),
      this.prometheusQuery.queryInstant(
        `flui:app_restart_rate_1h_by_pod{${podFilter}}`,
      ),
      this.prometheusQuery.queryInstant(
        `flui:app_pod_ready_by_pod{${podFilter}}`,
      ),
      this.prometheusQuery.queryInstant(
        `flui:app_pod_phase_by_pod{${podFilter}}`,
      ),
    ]);

    const volume = await this.getAppVolume(appId, namespace);

    return {
      app_id: appId,
      app_name: appName,
      namespace,
      cpu: {
        usage_cores: this.extractSumValue(cpuUsageRes),
        requests_cores: this.extractSumValue(cpuRequestsRes),
        limits_cores: this.extractSumValue(cpuLimitsRes),
        utilization_percent: this.extractSumValue(cpuUtilRes),
      },
      memory: {
        usage_bytes: this.extractSumValue(memUsageRes),
        requests_bytes: this.extractSumValue(memRequestsRes),
        limits_bytes: this.extractSumValue(memLimitsRes),
        utilization_percent: this.extractSumValue(memUtilRes),
      },
      network: {
        receive_bytes_rate: this.extractSumValue(netRxRes),
        transmit_bytes_rate: this.extractSumValue(netTxRes),
      },
      status: {
        replicas_desired: this.extractValue(replicasDesiredRes),
        replicas_ready: this.extractValue(replicasReadyRes),
        replicas_unavailable: this.extractValue(replicasUnavailRes),
        ready_ratio: this.extractValue(readyRatioRes),
        up: this.extractValue(appUpRes),
        restart_total: this.extractSumValue(restartTotalRes),
        restart_rate_1h: this.extractSumValue(restartRateRes),
      },
      pods: this.extractPodPhases(podsByPhaseRes),
      replicas: this.buildReplicaMetrics(
        cpuUsageByPodRes,
        cpuRequestsByPodRes,
        cpuLimitsByPodRes,
        cpuUtilByPodRes,
        memUsageByPodRes,
        memRequestsByPodRes,
        memLimitsByPodRes,
        memUtilByPodRes,
        netRxByPodRes,
        netTxByPodRes,
        restartByPodRes,
        restartRateByPodRes,
        podReadyByPodRes,
        podPhaseByPodRes,
      ),
      health: this.extractHealthStatus(app?.metadata),
      volume,
    };
  }

  /**
   * Persistent-volume (disk) usage for an app + a near-full alert level. Queries the raw
   * kubelet volume stats directly (no recording rule needed) filtered to the app's PVCs
   * (resolved from AppResources, same source the snapshot/backup features use). Returns null
   * when the app has no PVC or the metric isn't scraped — disk stays absent, never fabricated.
   */
  private async getAppVolume(
    appId: string,
    namespace: string,
  ): Promise<AppVolumeMetricsDto | null> {
    const pvcs = await this.appResourcesRepository.findByApplicationIdAndKind(
      appId,
      ApplicationResourceKind.PERSISTENT_VOLUME_CLAIM,
    );
    const names = pvcs.map((r) => r.name).filter((n): n is string => !!n);
    if (names.length === 0) return null;

    const sel = `namespace="${namespace}",persistentvolumeclaim=~"${names.join('|')}"`;
    const [usedRes, capRes, availRes] = await Promise.all([
      this.prometheusQuery.queryInstant(
        `sum(kubelet_volume_stats_used_bytes{${sel}})`,
      ),
      this.prometheusQuery.queryInstant(
        `sum(kubelet_volume_stats_capacity_bytes{${sel}})`,
      ),
      this.prometheusQuery.queryInstant(
        `sum(kubelet_volume_stats_available_bytes{${sel}})`,
      ),
    ]);

    const used = this.extractSumValue(usedRes);
    const capacity = this.extractSumValue(capRes);
    const available = this.extractSumValue(availRes);
    if (used === null && capacity === null) return null; // metric not scraped

    const utilization =
      capacity && capacity > 0 && used !== null
        ? (used / capacity) * 100
        : null;
    let alertLevel: 'none' | 'warning' | 'critical' = 'none';
    if (utilization !== null) {
      if (utilization >= 95) alertLevel = 'critical';
      else if (utilization >= 80) alertLevel = 'warning';
    }

    return {
      used_bytes: used,
      capacity_bytes: capacity,
      available_bytes: available,
      utilization_percent: utilization,
      alert_level: alertLevel,
    };
  }

  /**
   * Get instant metrics for the provided applications
   */
  async getAppsMetricsInstant(
    apps: ApplicationEntity[],
  ): Promise<AppMetricsDto[]> {
    if (apps.length === 0) {
      return [];
    }

    return Promise.all(
      apps.map((app) =>
        this.getAppMetricsInstant(app.id, app.slug, app.k8sNamespace),
      ),
    );
  }

  /**
   * Get metrics history for a single application over a time range
   */
  async getAppMetricsHistory(
    appId: string,
    appName: string,
    namespace: string,
    start: number,
    end: number,
    step: string = '60s',
  ): Promise<AppMetricsDataPointDto[]> {
    const podFilter = this.buildPodLabelFilter(appName, namespace);
    const workloadLabelKey = await this.resolveWorkloadLabelKey(appId);
    const deplFilter = this.buildWorkloadLabelFilter(
      appName,
      namespace,
      workloadLabelKey,
    );

    const [
      cpuUsageRes,
      cpuUtilRes,
      memUsageRes,
      memUtilRes,
      netRxRes,
      netTxRes,
      replDesiredRes,
      replReadyRes,
      restartRes,
      cpuUsageByPodRes,
      cpuUtilByPodRes,
      memUsageByPodRes,
      memUtilByPodRes,
      netRxByPodRes,
      netTxByPodRes,
      restartByPodRes,
    ] = await Promise.all([
      this.prometheusQuery.queryRange(
        `flui:app_cpu_usage_cores{${podFilter}}`,
        start,
        end,
        step,
      ),
      this.prometheusQuery.queryRange(
        `flui:app_cpu_utilization_percent{${podFilter}}`,
        start,
        end,
        step,
      ),
      this.prometheusQuery.queryRange(
        `flui:app_memory_usage_bytes{${podFilter}}`,
        start,
        end,
        step,
      ),
      this.prometheusQuery.queryRange(
        `flui:app_memory_utilization_percent{${podFilter}}`,
        start,
        end,
        step,
      ),
      this.prometheusQuery.queryRange(
        `flui:app_network_receive_bytes_rate{${podFilter}}`,
        start,
        end,
        step,
      ),
      this.prometheusQuery.queryRange(
        `flui:app_network_transmit_bytes_rate{${podFilter}}`,
        start,
        end,
        step,
      ),
      this.prometheusQuery.queryRange(
        `flui:app_replicas_desired{${deplFilter}}`,
        start,
        end,
        step,
      ),
      this.prometheusQuery.queryRange(
        `flui:app_replicas_ready{${deplFilter}}`,
        start,
        end,
        step,
      ),
      this.prometheusQuery.queryRange(
        `flui:app_restart_total{${podFilter}}`,
        start,
        end,
        step,
      ),
      this.prometheusQuery.queryRange(
        `flui:app_cpu_usage_cores_by_pod{${podFilter}}`,
        start,
        end,
        step,
      ),
      this.prometheusQuery.queryRange(
        `flui:app_cpu_utilization_percent_by_pod{${podFilter}}`,
        start,
        end,
        step,
      ),
      this.prometheusQuery.queryRange(
        `flui:app_memory_usage_bytes_by_pod{${podFilter}}`,
        start,
        end,
        step,
      ),
      this.prometheusQuery.queryRange(
        `flui:app_memory_utilization_percent_by_pod{${podFilter}}`,
        start,
        end,
        step,
      ),
      this.prometheusQuery.queryRange(
        `flui:app_network_receive_bytes_rate_by_pod{${podFilter}}`,
        start,
        end,
        step,
      ),
      this.prometheusQuery.queryRange(
        `flui:app_network_transmit_bytes_rate_by_pod{${podFilter}}`,
        start,
        end,
        step,
      ),
      this.prometheusQuery.queryRange(
        `flui:app_restart_total_by_pod{${podFilter}}`,
        start,
        end,
        step,
      ),
    ]);

    const cpuUsageByTs = this.rangeToMap(cpuUsageRes);
    const cpuUtilByTs = this.rangeToMap(cpuUtilRes);
    const memUsageByTs = this.rangeToMap(memUsageRes);
    const memUtilByTs = this.rangeToMap(memUtilRes);
    const netRxByTs = this.rangeToMap(netRxRes);
    const netTxByTs = this.rangeToMap(netTxRes);
    const replDesiredByTs = this.rangeToMap(replDesiredRes);
    const replReadyByTs = this.rangeToMap(replReadyRes);
    const restartByTs = this.rangeToMap(restartRes);

    const cpuUsageByPod = this.rangeToPodMap(cpuUsageByPodRes);
    const cpuUtilByPod = this.rangeToPodMap(cpuUtilByPodRes);
    const memUsageByPod = this.rangeToPodMap(memUsageByPodRes);
    const memUtilByPod = this.rangeToPodMap(memUtilByPodRes);
    const netRxByPod = this.rangeToPodMap(netRxByPodRes);
    const netTxByPod = this.rangeToPodMap(netTxByPodRes);
    const restartByPod = this.rangeToPodMap(restartByPodRes);

    const allTimestamps = new Set<number>();
    for (const map of [
      cpuUsageByTs,
      memUsageByTs,
      netRxByTs,
      replDesiredByTs,
    ]) {
      for (const ts of map.keys()) {
        allTimestamps.add(ts);
      }
    }

    const sorted = Array.from(allTimestamps).sort((a, b) => a - b);

    return sorted.map((ts) => {
      const replicas = this.buildReplicaDataPoints(ts, [
        { key: 'cpu_usage_cores', map: cpuUsageByPod },
        { key: 'cpu_utilization_percent', map: cpuUtilByPod },
        { key: 'memory_usage_bytes', map: memUsageByPod },
        { key: 'memory_utilization_percent', map: memUtilByPod },
        { key: 'network_receive_rate', map: netRxByPod },
        { key: 'network_transmit_rate', map: netTxByPod },
        { key: 'restart_total', map: restartByPod },
      ]);

      return {
        timestamp: ts,
        datetime: new Date(ts * 1000).toISOString(),
        cpu_usage_cores: cpuUsageByTs.get(ts),
        cpu_utilization_percent: cpuUtilByTs.get(ts),
        memory_usage_bytes: memUsageByTs.get(ts),
        memory_utilization_percent: memUtilByTs.get(ts),
        network_receive_rate: netRxByTs.get(ts),
        network_transmit_rate: netTxByTs.get(ts),
        replicas_desired: replDesiredByTs.get(ts),
        replicas_ready: replReadyByTs.get(ts),
        restart_total: restartByTs.get(ts),
        replicas: replicas.length > 0 ? replicas : undefined,
      };
    });
  }

  /**
   * Get metrics history for the provided applications
   */
  async getAppsMetricsHistory(
    apps: ApplicationEntity[],
    start: number,
    end: number,
    step: string = '60s',
  ): Promise<AppMetricsHistoryDto[]> {
    if (apps.length === 0) {
      return [];
    }

    return Promise.all(
      apps.map(async (app) => {
        const dataPoints = await this.getAppMetricsHistory(
          app.id,
          app.slug,
          app.k8sNamespace,
          start,
          end,
          step,
        );
        return {
          app_id: app.id,
          app_name: app.slug,
          namespace: app.k8sNamespace,
          data_points: dataPoints,
        };
      }),
    );
  }

  /**
   * Build PromQL label filter for pod-level metrics.
   * Recording rules key on: namespace, label_app_kubernetes_io_name
   */
  private buildPodLabelFilter(appName: string, namespace: string): string {
    return `namespace="${namespace}",label_app_kubernetes_io_name="${appName}"`;
  }

  /**
   * Resolve the kube-state-metrics label key for this app's primary workload.
   * Returns 'deployment' | 'statefulset' | 'daemonset' (default: 'deployment').
   */
  private async resolveWorkloadLabelKey(appId: string): Promise<string> {
    const resources =
      await this.appResourcesRepository.findByApplicationId(appId);
    const primary = resources.find(
      (r) => WORKLOAD_LABEL_KEY[r.kind] !== undefined,
    );
    return primary ? WORKLOAD_LABEL_KEY[primary.kind] : 'deployment';
  }

  /**
   * Build PromQL label filter for workload-level metrics.
   * Recording rules key on: namespace + the workload label (deployment/statefulset/daemonset).
   */
  private buildWorkloadLabelFilter(
    appName: string,
    namespace: string,
    workloadLabelKey: string = 'deployment',
  ): string {
    return `namespace="${namespace}",${workloadLabelKey}="${appName}"`;
  }

  /**
   * Extract a single scalar value from the first series in an instant query response.
   * Use for deployment-level metrics that return a single series.
   * Returns null if no data is available.
   */
  private extractValue(
    response: PrometheusInstantQueryResponse,
  ): number | null {
    if (
      response.status === 'success' &&
      response.data?.result?.length > 0 &&
      response.data.result[0].value
    ) {
      return Number.parseFloat(response.data.result[0].value[1]);
    }
    return null;
  }

  /**
   * Sum values across ALL series in an instant query response.
   * Use for pod-level metrics where multiple replicas each produce a series.
   * Returns null if no data is available.
   */
  private extractSumValue(
    response: PrometheusInstantQueryResponse,
  ): number | null {
    if (response.status !== 'success' || !response.data?.result?.length) {
      return null;
    }
    return response.data.result.reduce((acc, r) => {
      return acc + (r.value ? Number.parseFloat(r.value[1]) : 0);
    }, 0);
  }

  /**
   * Build a Map<podName, value> from a pod-level instant query response.
   * Each series is expected to have a `pod` label identifying the replica.
   */
  private extractByPod(
    response: PrometheusInstantQueryResponse,
  ): Map<string, number> {
    const map = new Map<string, number>();
    if (response.status !== 'success' || !response.data?.result?.length) {
      return map;
    }
    for (const r of response.data.result) {
      const pod = r.metric.pod || r.metric.instance || 'unknown';
      if (r.value) {
        map.set(pod, Number.parseFloat(r.value[1]));
      }
    }
    return map;
  }

  /**
   * Build per-replica metrics from the pod-level instant query responses.
   */
  private buildReplicaMetrics(
    cpuUsageRes: PrometheusInstantQueryResponse,
    cpuRequestsRes: PrometheusInstantQueryResponse,
    cpuLimitsRes: PrometheusInstantQueryResponse,
    cpuUtilRes: PrometheusInstantQueryResponse,
    memUsageRes: PrometheusInstantQueryResponse,
    memRequestsRes: PrometheusInstantQueryResponse,
    memLimitsRes: PrometheusInstantQueryResponse,
    memUtilRes: PrometheusInstantQueryResponse,
    netRxRes: PrometheusInstantQueryResponse,
    netTxRes: PrometheusInstantQueryResponse,
    restartTotalRes: PrometheusInstantQueryResponse,
    restartRateRes: PrometheusInstantQueryResponse,
    podReadyRes: PrometheusInstantQueryResponse,
    podPhaseRes: PrometheusInstantQueryResponse,
  ): ReplicaMetricsDto[] {
    const cpuUsage = this.extractByPod(cpuUsageRes);
    const cpuRequests = this.extractByPod(cpuRequestsRes);
    const cpuLimits = this.extractByPod(cpuLimitsRes);
    const cpuUtil = this.extractByPod(cpuUtilRes);
    const memUsage = this.extractByPod(memUsageRes);
    const memRequests = this.extractByPod(memRequestsRes);
    const memLimits = this.extractByPod(memLimitsRes);
    const memUtil = this.extractByPod(memUtilRes);
    const netRx = this.extractByPod(netRxRes);
    const netTx = this.extractByPod(netTxRes);
    const restarts = this.extractByPod(restartTotalRes);
    const restartRate = this.extractByPod(restartRateRes);
    const podReady = this.extractByPod(podReadyRes);
    const podPhase = this.extractPodPhaseByPod(podPhaseRes);

    const pods = new Set([
      ...cpuUsage.keys(),
      ...memUsage.keys(),
      ...netRx.keys(),
    ]);

    return Array.from(pods).map((pod) => ({
      pod,
      cpu: {
        usage_cores: cpuUsage.get(pod) ?? null,
        requests_cores: cpuRequests.get(pod) ?? null,
        limits_cores: cpuLimits.get(pod) ?? null,
        utilization_percent: cpuUtil.get(pod) ?? null,
      },
      memory: {
        usage_bytes: memUsage.get(pod) ?? null,
        requests_bytes: memRequests.get(pod) ?? null,
        limits_bytes: memLimits.get(pod) ?? null,
        utilization_percent: memUtil.get(pod) ?? null,
      },
      network: {
        receive_bytes_rate: netRx.get(pod) ?? null,
        transmit_bytes_rate: netTx.get(pod) ?? null,
      },
      status: {
        ready: podReady.get(pod) ?? null,
        phase: podPhase.get(pod) ?? null,
        restart_total: restarts.get(pod) ?? null,
        restart_rate_1h: restartRate.get(pod) ?? null,
      },
    }));
  }

  /**
   * Extract a Map<podName, phase> from a pod phase instant query response.
   * The metric has a `phase` label with the phase name.
   */
  private extractPodPhaseByPod(
    response: PrometheusInstantQueryResponse,
  ): Map<string, string> {
    const map = new Map<string, string>();
    if (response.status !== 'success' || !response.data?.result?.length) {
      return map;
    }
    for (const r of response.data.result) {
      const pod = r.metric.pod || r.metric.instance || 'unknown';
      const phase = r.metric.phase;
      if (phase && r.value && Number.parseFloat(r.value[1]) > 0) {
        map.set(pod, phase);
      }
    }
    return map;
  }

  /**
   * Extract pod phase counts from an instant query response.
   * The flui:app_pods_by_phase metric returns multiple results,
   * one per phase (Running, Pending, Failed, etc.).
   */
  private extractPodPhases(
    response: PrometheusInstantQueryResponse,
  ): AppPodPhaseDto[] {
    if (response.status !== 'success' || !response.data?.result?.length) {
      return [];
    }
    return response.data.result
      .map((r) => ({
        phase: r.metric.phase || 'Unknown',
        count: Number.parseFloat(r.value?.[1] || '0'),
      }))
      .filter((p) => p.count > 0);
  }

  /**
   * Build a Map<timestamp, value> from a range query response,
   * summing across ALL series per timestamp to handle multiple replicas.
   */
  private rangeToMap(
    response: PrometheusRangeQueryResponse,
  ): Map<number, number> {
    const map = new Map<number, number>();
    if (response.status !== 'success' || !response.data?.result?.length) {
      return map;
    }
    for (const series of response.data.result) {
      for (const [ts, val] of series.values ?? []) {
        map.set(ts, (map.get(ts) ?? 0) + Number.parseFloat(val));
      }
    }
    return map;
  }

  /**
   * Build Map<podName, Map<timestamp, value>> from a per-pod range query response.
   * Each series carries a `pod` label that identifies the replica.
   */
  private rangeToPodMap(
    response: PrometheusRangeQueryResponse,
  ): Map<string, Map<number, number>> {
    const out = new Map<string, Map<number, number>>();
    if (response.status !== 'success' || !response.data?.result?.length) {
      return out;
    }
    for (const series of response.data.result) {
      const pod = series.metric?.pod || series.metric?.instance || 'unknown';
      let inner = out.get(pod);
      if (!inner) {
        inner = new Map<number, number>();
        out.set(pod, inner);
      }
      for (const [ts, val] of series.values ?? []) {
        inner.set(ts, Number.parseFloat(val));
      }
    }
    return out;
  }

  /**
   * Compose per-replica data points for a single timestamp by collecting
   * values across all per-pod metric maps. Pods with no data at this
   * timestamp across every metric are omitted.
   */
  private buildReplicaDataPoints(
    ts: number,
    metrics: ReadonlyArray<{
      key: keyof ReplicaMetricsDataPointDto;
      map: Map<string, Map<number, number>>;
    }>,
  ): ReplicaMetricsDataPointDto[] {
    const pods = new Set<string>();
    for (const { map } of metrics) {
      for (const pod of map.keys()) pods.add(pod);
    }
    if (pods.size === 0) return [];

    const out: ReplicaMetricsDataPointDto[] = [];
    for (const pod of pods) {
      const entry: ReplicaMetricsDataPointDto = { pod };
      let hasAny = false;
      for (const { key, map } of metrics) {
        const val = map.get(pod)?.get(ts);
        if (val !== undefined) {
          (entry as unknown as Record<string, number>)[key as string] = val;
          hasAny = true;
        }
      }
      if (hasAny) out.push(entry);
    }
    return out;
  }

  /**
   * Maps app entity metadata.healthStatus (written by reconciliation) to AppHealthStatusDto.
   */
  private extractHealthStatus(
    metadata: Record<string, string> | undefined,
  ): AppHealthStatusDto | undefined {
    const raw = metadata?.['healthStatus'];
    if (!raw) return undefined;
    let hs: Record<string, unknown>;
    try {
      hs = JSON.parse(raw);
    } catch {
      return undefined;
    }
    return {
      ready_pods: (hs['readyPods'] as number) ?? null,
      total_pods: (hs['totalPods'] as number) ?? null,
      unavailable_pods: (hs['unavailablePods'] as number) ?? null,
      condition_message: (hs['conditionMessage'] as string) ?? null,
      checked_at: (hs['checkedAt'] as string) ?? null,
    };
  }
}
