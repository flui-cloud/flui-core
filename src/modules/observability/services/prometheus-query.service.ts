import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import {
  PrometheusInstantQueryResponse,
  PrometheusRangeQueryResponse,
  PrometheusQueryResult,
} from '../interfaces/prometheus-response.interface';

/**
 * Prometheus Query Service
 *
 * Executes PromQL queries against Prometheus HTTP API
 * and provides helper methods for common metrics queries.
 */
@Injectable()
export class PrometheusQueryService {
  private readonly logger = new Logger(PrometheusQueryService.name);
  private readonly prometheusUrl: string;
  private readonly httpClient: AxiosInstance;

  constructor(private readonly configService: ConfigService) {
    this.prometheusUrl =
      this.configService.get<string>('PROMETHEUS_ENDPOINT') ||
      'http://localhost:9090';

    this.httpClient = axios.create({
      baseURL: this.prometheusUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    this.logger.log(`Prometheus client initialized: ${this.prometheusUrl}`);
  }

  /**
   * Execute instant PromQL query
   */
  async queryInstant(query: string): Promise<PrometheusInstantQueryResponse> {
    try {
      const response = await this.httpClient.get('/api/v1/query', {
        params: { query },
      });

      return response.data;
    } catch (error) {
      this.logger.error(
        `Instant query failed: ${error.message}, query: ${query}`,
      );
      throw new Error(`Prometheus query failed: ${error.message}`);
    }
  }

  /**
   * Execute range PromQL query
   */
  async queryRange(
    query: string,
    start: number,
    end: number,
    step: string = '60s',
  ): Promise<PrometheusRangeQueryResponse> {
    try {
      const response = await this.httpClient.get('/api/v1/query_range', {
        params: { query, start, end, step },
      });

      return response.data;
    } catch (error) {
      this.logger.error(
        `Range query failed: ${error.message}, query: ${query}`,
      );
      throw new Error(`Prometheus range query failed: ${error.message}`);
    }
  }

  /**
   * Get CPU usage percentage.
   *
   * - When `serverId` is provided: returns CPU% of that single node.
   * - When omitted: returns the **cluster-wide average** across all nodes
   *   matching cluster_id. The previous implementation grouped by instance
   *   and returned `result[0]`, which silently surfaced only the first node
   *   (typically the master) once a worker was added.
   */
  async getServerCpuUsage(
    clusterId: string,
    serverId?: string,
  ): Promise<number | null> {
    const labelFilter = serverId
      ? `cluster_id="${clusterId}",server_id="${serverId}"`
      : `cluster_id="${clusterId}"`;
    const query = serverId
      ? `100 - (avg by (instance) (rate(node_cpu_seconds_total{mode="idle",${labelFilter}}[5m])) * 100)`
      : `100 - (avg(rate(node_cpu_seconds_total{mode="idle",${labelFilter}}[5m])) * 100)`;

    const result = await this.queryInstant(query);

    if (
      result.status === 'success' &&
      result.data?.result &&
      result.data.result.length > 0
    ) {
      return Number.parseFloat(result.data.result[0].value[1]);
    }

    return null;
  }

  /**
   * Get memory usage percentage.
   *
   * - When `serverId` is provided: returns mem% of that single node.
   * - When omitted: returns the **cluster-wide average** computed as
   *   `1 - sum(MemAvailable) / sum(MemTotal)` so that adding a fresh worker
   *   (low memory pressure) lowers the cluster value, instead of the call
   *   returning the master's value alone.
   */
  async getServerMemoryUsage(
    clusterId: string,
    serverId?: string,
  ): Promise<number | null> {
    const labelFilter = serverId
      ? `cluster_id="${clusterId}",server_id="${serverId}"`
      : `cluster_id="${clusterId}"`;
    const query = serverId
      ? `100 * (1 - (node_memory_MemAvailable_bytes{${labelFilter}} / node_memory_MemTotal_bytes{${labelFilter}}))`
      : `100 * (1 - sum(node_memory_MemAvailable_bytes{${labelFilter}}) / sum(node_memory_MemTotal_bytes{${labelFilter}}))`;

    const result = await this.queryInstant(query);

    if (
      result.status === 'success' &&
      result.data?.result &&
      result.data.result.length > 0
    ) {
      return Number.parseFloat(result.data.result[0].value[1]);
    }

    return null;
  }

  /**
   * Get disk usage percentage.
   *
   * - With `serverId`: that node's root filesystem usage.
   * - Without: cluster-wide root filesystem usage as
   *   `1 - sum(avail) / sum(size)` — same fix as memory.
   */
  async getServerDiskUsage(
    clusterId: string,
    serverId?: string,
  ): Promise<number | null> {
    const labelFilter = serverId
      ? `cluster_id="${clusterId}",server_id="${serverId}"`
      : `cluster_id="${clusterId}"`;
    const query = serverId
      ? `100 - ((node_filesystem_avail_bytes{${labelFilter},mountpoint="/"} / node_filesystem_size_bytes{${labelFilter},mountpoint="/"}) * 100)`
      : `100 - (sum(node_filesystem_avail_bytes{${labelFilter},mountpoint="/"}) / sum(node_filesystem_size_bytes{${labelFilter},mountpoint="/"}) * 100)`;

    const result = await this.queryInstant(query);

    if (
      result.status === 'success' &&
      result.data?.result &&
      result.data.result.length > 0
    ) {
      return Number.parseFloat(result.data.result[0].value[1]);
    }

    return null;
  }

  /**
   * Get total memory in bytes for a server
   */
  async getServerTotalMemory(
    clusterId: string,
    serverId?: string,
  ): Promise<number | null> {
    const labelFilter = serverId
      ? `cluster_id="${clusterId}",server_id="${serverId}"`
      : `cluster_id="${clusterId}"`;
    const query = `node_memory_MemTotal_bytes{${labelFilter}}`;

    const result = await this.queryInstant(query);

    if (
      result.status === 'success' &&
      result.data?.result &&
      result.data.result.length > 0
    ) {
      return Number.parseFloat(result.data.result[0].value[1]);
    }

    return null;
  }

  /**
   * Get total disk space in bytes for a server
   */
  async getServerTotalDisk(
    clusterId: string,
    serverId?: string,
  ): Promise<number | null> {
    const labelFilter = serverId
      ? `cluster_id="${clusterId}",server_id="${serverId}"`
      : `cluster_id="${clusterId}"`;
    const query = `node_filesystem_size_bytes{${labelFilter},mountpoint="/"}`;

    const result = await this.queryInstant(query);

    if (
      result.status === 'success' &&
      result.data?.result &&
      result.data.result.length > 0
    ) {
      return Number.parseFloat(result.data.result[0].value[1]);
    }

    return null;
  }

  /**
   * Get network bytes received rate
   */
  async getServerNetworkBytesIn(
    clusterId: string,
    serverId?: string,
  ): Promise<number | null> {
    const labelFilter = serverId
      ? `cluster_id="${clusterId}",server_id="${serverId}"`
      : `cluster_id="${clusterId}"`;
    const query = `sum by (instance, server_id) (rate(node_network_receive_bytes_total{${labelFilter},device!~"lo|cni.*|veth.*|flannel.*|docker.*|kube-ipvs.*|tunl.*|cilium.*|nodelocaldns.*|dummy.*"}[5m]))`;

    const result = await this.queryInstant(query);

    if (
      result.status === 'success' &&
      result.data?.result &&
      result.data.result.length > 0
    ) {
      return Number.parseFloat(result.data.result[0].value[1]);
    }

    return null;
  }

  /**
   * Get network bytes transmitted rate
   */
  async getServerNetworkBytesOut(
    clusterId: string,
    serverId?: string,
  ): Promise<number | null> {
    const labelFilter = serverId
      ? `cluster_id="${clusterId}",server_id="${serverId}"`
      : `cluster_id="${clusterId}"`;
    const query = `sum by (instance, server_id) (rate(node_network_transmit_bytes_total{${labelFilter},device!~"lo|cni.*|veth.*|flannel.*|docker.*|kube-ipvs.*|tunl.*|cilium.*|nodelocaldns.*|dummy.*"}[5m]))`;

    const result = await this.queryInstant(query);

    if (
      result.status === 'success' &&
      result.data?.result &&
      result.data.result.length > 0
    ) {
      return Number.parseFloat(result.data.result[0].value[1]);
    }

    return null;
  }

  /**
   * Get CPU core count
   */
  async getServerCpuCores(
    clusterId: string,
    serverId?: string,
  ): Promise<number | null> {
    const labelFilter = serverId
      ? `cluster_id="${clusterId}",server_id="${serverId}"`
      : `cluster_id="${clusterId}"`;
    const query = `count(node_cpu_seconds_total{${labelFilter},mode="idle"})`;

    const result = await this.queryInstant(query);

    if (
      result.status === 'success' &&
      result.data?.result &&
      result.data.result.length > 0
    ) {
      return Number.parseInt(result.data.result[0].value[1], 10);
    }

    return null;
  }

  /**
   * Get used memory in bytes for a server
   */
  async getServerMemoryUsed(
    clusterId: string,
    serverId?: string,
  ): Promise<number | null> {
    const labelFilter = serverId
      ? `cluster_id="${clusterId}",server_id="${serverId}"`
      : `cluster_id="${clusterId}"`;
    const query = `node_memory_MemTotal_bytes{${labelFilter}} - node_memory_MemAvailable_bytes{${labelFilter}}`;

    const result = await this.queryInstant(query);

    if (
      result.status === 'success' &&
      result.data?.result &&
      result.data.result.length > 0
    ) {
      return Number.parseFloat(result.data.result[0].value[1]);
    }

    return null;
  }

  /**
   * Get available memory in bytes for a server
   */
  async getServerMemoryAvailable(
    clusterId: string,
    serverId?: string,
  ): Promise<number | null> {
    const labelFilter = serverId
      ? `cluster_id="${clusterId}",server_id="${serverId}"`
      : `cluster_id="${clusterId}"`;
    const query = `node_memory_MemAvailable_bytes{${labelFilter}}`;

    const result = await this.queryInstant(query);

    if (
      result.status === 'success' &&
      result.data?.result &&
      result.data.result.length > 0
    ) {
      return Number.parseFloat(result.data.result[0].value[1]);
    }

    return null;
  }

  /**
   * Get used disk space in bytes for a server
   */
  async getServerDiskUsed(
    clusterId: string,
    serverId?: string,
  ): Promise<number | null> {
    const labelFilter = serverId
      ? `cluster_id="${clusterId}",server_id="${serverId}"`
      : `cluster_id="${clusterId}"`;
    const query = `node_filesystem_size_bytes{${labelFilter},mountpoint="/"} - node_filesystem_avail_bytes{${labelFilter},mountpoint="/"}`;

    const result = await this.queryInstant(query);

    if (
      result.status === 'success' &&
      result.data?.result &&
      result.data.result.length > 0
    ) {
      return Number.parseFloat(result.data.result[0].value[1]);
    }

    return null;
  }

  /**
   * Get available disk space in bytes for a server
   */
  async getServerDiskAvailable(
    clusterId: string,
    serverId?: string,
  ): Promise<number | null> {
    const labelFilter = serverId
      ? `cluster_id="${clusterId}",server_id="${serverId}"`
      : `cluster_id="${clusterId}"`;
    const query = `node_filesystem_avail_bytes{${labelFilter},mountpoint="/"}`;

    const result = await this.queryInstant(query);

    if (
      result.status === 'success' &&
      result.data?.result &&
      result.data.result.length > 0
    ) {
      return Number.parseFloat(result.data.result[0].value[1]);
    }

    return null;
  }

  /**
   * Get system load averages for a server
   */
  async getServerLoad(
    clusterId: string,
    serverId?: string,
  ): Promise<{ load1: number; load5: number; load15: number } | null> {
    const labelFilter = serverId
      ? `cluster_id="${clusterId}",server_id="${serverId}"`
      : `cluster_id="${clusterId}"`;

    const [load1Result, load5Result, load15Result] = await Promise.all([
      this.queryInstant(`node_load1{${labelFilter}}`),
      this.queryInstant(`node_load5{${labelFilter}}`),
      this.queryInstant(`node_load15{${labelFilter}}`),
    ]);

    if (
      load1Result.status === 'success' &&
      load1Result.data?.result?.length > 0 &&
      load5Result.status === 'success' &&
      load5Result.data?.result?.length > 0 &&
      load15Result.status === 'success' &&
      load15Result.data?.result?.length > 0
    ) {
      return {
        load1: Number.parseFloat(load1Result.data.result[0].value[1]),
        load5: Number.parseFloat(load5Result.data.result[0].value[1]),
        load15: Number.parseFloat(load15Result.data.result[0].value[1]),
      };
    }

    return null;
  }

  /**
   * Get server uptime in seconds
   */
  async getServerUptime(
    clusterId: string,
    serverId?: string,
  ): Promise<number | null> {
    const labelFilter = serverId
      ? `cluster_id="${clusterId}",server_id="${serverId}"`
      : `cluster_id="${clusterId}"`;
    const query = `time() - node_boot_time_seconds{${labelFilter}}`;

    const result = await this.queryInstant(query);

    if (
      result.status === 'success' &&
      result.data?.result &&
      result.data.result.length > 0
    ) {
      return Number.parseFloat(result.data.result[0].value[1]);
    }

    return null;
  }

  /**
   * Extract all per-instance values from an instant query result.
   * Groups by instance label so each server gets its own value.
   */
  private extractPerInstance(
    result: PrometheusInstantQueryResponse,
  ): Map<string, PrometheusQueryResult> {
    const map = new Map<string, PrometheusQueryResult>();
    if (
      result.status === 'success' &&
      result.data?.result &&
      result.data.result.length > 0
    ) {
      for (const entry of result.data.result) {
        const instance = entry.metric.instance || 'unknown';
        map.set(instance, entry);
      }
    }
    return map;
  }

  /**
   * Extract all per-instance time-series from a range query result.
   * Groups by instance label, each entry contains the full values array.
   */
  private extractPerInstanceRange(
    result: PrometheusRangeQueryResponse,
  ): Map<string, PrometheusQueryResult> {
    return this.extractPerInstance(
      result as unknown as PrometheusInstantQueryResponse,
    );
  }

  /**
   * Get historical metrics for all servers in a cluster over a time range.
   * Runs 5 range queries in parallel (cpu, memory, disk, net in, net out),
   * then merges the results per-instance and per-timestamp.
   */
  async getMetricsHistory(
    clusterId: string,
    start: number,
    end: number,
    step: string = '60s',
    serverId?: string,
  ): Promise<
    Map<
      string,
      {
        server_id?: string;
        data_points: Array<{
          timestamp: number;
          cpu_percent?: number;
          memory_percent?: number;
          disk_percent?: number;
          network_in?: number;
          network_out?: number;
        }>;
      }
    >
  > {
    const lf = serverId
      ? `cluster_id="${clusterId}",server_id="${serverId}"`
      : `cluster_id="${clusterId}"`;

    const [cpuRes, memRes, diskRes, netInRes, netOutRes] = await Promise.all([
      this.queryRange(
        `100 - (avg by (instance, server_id) (rate(node_cpu_seconds_total{mode="idle",${lf}}[5m])) * 100)`,
        start,
        end,
        step,
      ),
      this.queryRange(
        `100 * (1 - (node_memory_MemAvailable_bytes{${lf}} / node_memory_MemTotal_bytes{${lf}}))`,
        start,
        end,
        step,
      ),
      this.queryRange(
        `100 - ((node_filesystem_avail_bytes{${lf},mountpoint="/"} / node_filesystem_size_bytes{${lf},mountpoint="/"}) * 100)`,
        start,
        end,
        step,
      ),
      this.queryRange(
        `sum by (instance, server_id) (rate(node_network_receive_bytes_total{${lf},device!~"lo|cni.*|veth.*|flannel.*|docker.*|kube-ipvs.*|tunl.*|cilium.*|nodelocaldns.*|dummy.*"}[5m]))`,
        start,
        end,
        step,
      ),
      this.queryRange(
        `sum by (instance, server_id) (rate(node_network_transmit_bytes_total{${lf},device!~"lo|cni.*|veth.*|flannel.*|docker.*|kube-ipvs.*|tunl.*|cilium.*|nodelocaldns.*|dummy.*"}[5m]))`,
        start,
        end,
        step,
      ),
    ]);

    const cpuMap = this.extractPerInstanceRange(cpuRes);
    const memMap = this.extractPerInstanceRange(memRes);
    const diskMap = this.extractPerInstanceRange(diskRes);
    const netInMap = this.extractPerInstanceRange(netInRes);
    const netOutMap = this.extractPerInstanceRange(netOutRes);

    // Collect all unique instances
    const allInstances = new Set<string>();
    for (const map of [cpuMap, memMap, diskMap, netInMap, netOutMap]) {
      for (const key of map.keys()) {
        allInstances.add(key);
      }
    }

    const result = new Map<
      string,
      {
        server_id?: string;
        data_points: Array<{
          timestamp: number;
          cpu_percent?: number;
          memory_percent?: number;
          disk_percent?: number;
          network_in?: number;
          network_out?: number;
        }>;
      }
    >();

    for (const instance of allInstances) {
      const cpuValues = cpuMap.get(instance)?.values || [];
      const memValues = memMap.get(instance)?.values || [];
      const diskValues = diskMap.get(instance)?.values || [];
      const netInValues = netInMap.get(instance)?.values || [];
      const netOutValues = netOutMap.get(instance)?.values || [];

      // Index secondary metrics by timestamp for O(1) lookup
      const memByTs = new Map(
        memValues.map(([ts, v]) => [ts, Number.parseFloat(v)]),
      );
      const diskByTs = new Map(
        diskValues.map(([ts, v]) => [ts, Number.parseFloat(v)]),
      );
      const netInByTs = new Map(
        netInValues.map(([ts, v]) => [ts, Number.parseFloat(v)]),
      );
      const netOutByTs = new Map(
        netOutValues.map(([ts, v]) => [ts, Number.parseFloat(v)]),
      );

      // Collect all unique timestamps across all metrics for this instance.
      // The network series belong in this union too: a timestamp only they
      // carry used to be dropped, silently turning real traffic into a gap.
      const allTimestamps = new Set<number>();
      for (const [ts] of cpuValues) allTimestamps.add(ts);
      for (const [ts] of memValues) allTimestamps.add(ts);
      for (const [ts] of diskValues) allTimestamps.add(ts);
      for (const [ts] of netInValues) allTimestamps.add(ts);
      for (const [ts] of netOutValues) allTimestamps.add(ts);

      const cpuByTs = new Map(
        cpuValues.map(([ts, v]) => [ts, Number.parseFloat(v)]),
      );

      const sortedTimestamps = Array.from(allTimestamps).sort((a, b) => a - b);

      const dataPoints = sortedTimestamps.map((ts) => ({
        timestamp: ts,
        cpu_percent: cpuByTs.get(ts),
        memory_percent: memByTs.get(ts),
        disk_percent: diskByTs.get(ts),
        network_in: netInByTs.get(ts),
        network_out: netOutByTs.get(ts),
      }));

      // Get server_id from any available metric
      const anyEntry =
        cpuMap.get(instance) || memMap.get(instance) || diskMap.get(instance);

      result.set(instance, {
        server_id: anyEntry?.metric.server_id,
        data_points: dataPoints,
      });
    }

    return result;
  }

  /**
   * Get all metrics for every server in a cluster in a single batch.
   * Returns a map keyed by instance, each containing all metric values.
   */
  async getAllServerMetrics(
    clusterId: string,
    serverId?: string,
  ): Promise<
    Map<
      string,
      {
        server_id?: string;
        cpu: number | null;
        cores: number | null;
        memory_usage: number | null;
        memory_total: number | null;
        memory_used: number | null;
        memory_available: number | null;
        disk_usage: number | null;
        disk_total: number | null;
        disk_used: number | null;
        disk_available: number | null;
        bytes_in: number | null;
        bytes_out: number | null;
        load: { load1: number; load5: number; load15: number } | null;
        uptime: number | null;
      }
    >
  > {
    const lf = serverId
      ? `cluster_id="${clusterId}",server_id="${serverId}"`
      : `cluster_id="${clusterId}"`;

    const [
      cpuRes,
      memUsageRes,
      memTotalRes,
      memUsedRes,
      memAvailRes,
      diskUsageRes,
      diskTotalRes,
      diskUsedRes,
      diskAvailRes,
      netInRes,
      netOutRes,
      coresRes,
      load1Res,
      load5Res,
      load15Res,
      uptimeRes,
    ] = await Promise.all([
      this.queryInstant(
        `100 - (avg by (instance, server_id) (rate(node_cpu_seconds_total{mode="idle",${lf}}[5m])) * 100)`,
      ),
      this.queryInstant(
        `100 * (1 - (node_memory_MemAvailable_bytes{${lf}} / node_memory_MemTotal_bytes{${lf}}))`,
      ),
      this.queryInstant(`node_memory_MemTotal_bytes{${lf}}`),
      this.queryInstant(
        `node_memory_MemTotal_bytes{${lf}} - node_memory_MemAvailable_bytes{${lf}}`,
      ),
      this.queryInstant(`node_memory_MemAvailable_bytes{${lf}}`),
      this.queryInstant(
        `100 - ((node_filesystem_avail_bytes{${lf},mountpoint="/"} / node_filesystem_size_bytes{${lf},mountpoint="/"}) * 100)`,
      ),
      this.queryInstant(`node_filesystem_size_bytes{${lf},mountpoint="/"}`),
      this.queryInstant(
        `node_filesystem_size_bytes{${lf},mountpoint="/"} - node_filesystem_avail_bytes{${lf},mountpoint="/"}`,
      ),
      this.queryInstant(`node_filesystem_avail_bytes{${lf},mountpoint="/"}`),
      this.queryInstant(
        `sum by (instance, server_id) (rate(node_network_receive_bytes_total{${lf},device!~"lo|cni.*|veth.*|flannel.*|docker.*|kube-ipvs.*|tunl.*|cilium.*|nodelocaldns.*|dummy.*"}[5m]))`,
      ),
      this.queryInstant(
        `sum by (instance, server_id) (rate(node_network_transmit_bytes_total{${lf},device!~"lo|cni.*|veth.*|flannel.*|docker.*|kube-ipvs.*|tunl.*|cilium.*|nodelocaldns.*|dummy.*"}[5m]))`,
      ),
      this.queryInstant(
        `count by (instance, server_id) (node_cpu_seconds_total{${lf},mode="idle"})`,
      ),
      this.queryInstant(`node_load1{${lf}}`),
      this.queryInstant(`node_load5{${lf}}`),
      this.queryInstant(`node_load15{${lf}}`),
      this.queryInstant(`time() - node_boot_time_seconds{${lf}}`),
    ]);

    // Debug: log all available network devices (uses a lightweight instant query)
    this.queryInstant(`node_network_receive_bytes_total{${lf}}`)
      .then((devicesRes) => {
        if (
          devicesRes.status === 'success' &&
          devicesRes.data?.result?.length
        ) {
          const devices = [
            ...new Set(
              devicesRes.data.result
                .map((r) => r.metric.device)
                .filter(Boolean),
            ),
          ];
          this.logger.debug(
            `Network devices found for cluster ${clusterId}: [${devices.join(', ')}] (using eth0 only)`,
          );
        }
      })
      .catch(() => {
        /* best-effort debug log */
      });

    const cpuMap = this.extractPerInstance(cpuRes);
    const memUsageMap = this.extractPerInstance(memUsageRes);
    const memTotalMap = this.extractPerInstance(memTotalRes);
    const memUsedMap = this.extractPerInstance(memUsedRes);
    const memAvailMap = this.extractPerInstance(memAvailRes);
    const diskUsageMap = this.extractPerInstance(diskUsageRes);
    const diskTotalMap = this.extractPerInstance(diskTotalRes);
    const diskUsedMap = this.extractPerInstance(diskUsedRes);
    const diskAvailMap = this.extractPerInstance(diskAvailRes);
    const netInMap = this.extractPerInstance(netInRes);
    const netOutMap = this.extractPerInstance(netOutRes);
    const coresMap = this.extractPerInstance(coresRes);
    const load1Map = this.extractPerInstance(load1Res);
    const load5Map = this.extractPerInstance(load5Res);
    const load15Map = this.extractPerInstance(load15Res);
    const uptimeMap = this.extractPerInstance(uptimeRes);

    // Collect all unique instances across all queries
    const allInstances = new Set<string>();
    for (const map of [
      cpuMap,
      memTotalMap,
      diskTotalMap,
      coresMap,
      uptimeMap,
    ]) {
      for (const key of map.keys()) {
        allInstances.add(key);
      }
    }

    const result = new Map<
      string,
      {
        server_id?: string;
        cpu: number | null;
        cores: number | null;
        memory_usage: number | null;
        memory_total: number | null;
        memory_used: number | null;
        memory_available: number | null;
        disk_usage: number | null;
        disk_total: number | null;
        disk_used: number | null;
        disk_available: number | null;
        bytes_in: number | null;
        bytes_out: number | null;
        load: { load1: number; load5: number; load15: number } | null;
        uptime: number | null;
      }
    >();

    const val = (
      map: Map<string, PrometheusQueryResult>,
      instance: string,
    ): number | null => {
      const entry = map.get(instance);
      return entry?.value ? Number.parseFloat(entry.value[1]) : null;
    };

    const intVal = (
      map: Map<string, PrometheusQueryResult>,
      instance: string,
    ): number | null => {
      const entry = map.get(instance);
      return entry?.value ? Number.parseInt(entry.value[1], 10) : null;
    };

    for (const instance of allInstances) {
      const anyEntry =
        cpuMap.get(instance) ||
        memTotalMap.get(instance) ||
        coresMap.get(instance);
      const srvId = anyEntry?.metric.server_id;

      const l1 = val(load1Map, instance);
      const l5 = val(load5Map, instance);
      const l15 = val(load15Map, instance);

      result.set(instance, {
        server_id: srvId,
        cpu: val(cpuMap, instance),
        cores: intVal(coresMap, instance),
        memory_usage: val(memUsageMap, instance),
        memory_total: val(memTotalMap, instance),
        memory_used: val(memUsedMap, instance),
        memory_available: val(memAvailMap, instance),
        disk_usage: val(diskUsageMap, instance),
        disk_total: val(diskTotalMap, instance),
        disk_used: val(diskUsedMap, instance),
        disk_available: val(diskAvailMap, instance),
        bytes_in: val(netInMap, instance),
        bytes_out: val(netOutMap, instance),
        load:
          l1 !== null && l5 !== null && l15 !== null
            ? { load1: l1, load5: l5, load15: l15 }
            : null,
        uptime: val(uptimeMap, instance),
      });
    }

    return result;
  }

  /**
   * Get current up/down status for all targets in a cluster.
   * Returns the raw Prometheus results so the caller can iterate per-target.
   */
  async getClusterTargetsHealth(
    clusterId: string,
    serverId?: string,
  ): Promise<PrometheusQueryResult[]> {
    const labelFilter = serverId
      ? `cluster_id="${clusterId}",server_id="${serverId}"`
      : `cluster_id="${clusterId}"`;
    const query = `up{${labelFilter}}`;

    const result = await this.queryInstant(query);

    if (
      result.status === 'success' &&
      result.data?.result &&
      result.data.result.length > 0
    ) {
      return result.data.result;
    }

    return [];
  }

  /**
   * Get historical up/down status for all targets in a cluster over a time range.
   * Returns per-target time-series with [timestamp, value] arrays.
   */
  async getClusterTargetsHealthHistory(
    clusterId: string,
    start: number,
    end: number,
    step: string = '60s',
    serverId?: string,
  ): Promise<PrometheusQueryResult[]> {
    const labelFilter = serverId
      ? `cluster_id="${clusterId}",server_id="${serverId}"`
      : `cluster_id="${clusterId}"`;
    const query = `up{${labelFilter}}`;

    const result = await this.queryRange(query, start, end, step);

    if (
      result.status === 'success' &&
      result.data?.result &&
      result.data.result.length > 0
    ) {
      return result.data.result;
    }

    return [];
  }
}
