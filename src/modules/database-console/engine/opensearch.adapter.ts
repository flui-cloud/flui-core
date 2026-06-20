import { Injectable } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { Agent } from 'node:https';
import {
  SearchClusterInfo,
  SearchConnectParams,
  SearchConnection,
  SearchEngine,
  SearchEngineAdapter,
  SearchIndex,
  SearchResponse,
} from './search-engine';
import { RawRestRequest, RawRestResponse } from './raw-rest';

class OpenSearchConnection implements SearchConnection {
  constructor(private readonly http: AxiosInstance) {}

  async clusterInfo(): Promise<SearchClusterInfo> {
    const { data } = await this.http.get<{
      cluster_name?: string;
      version?: { number?: string; distribution?: string };
    }>('/');
    return {
      clusterName: data.cluster_name ?? 'unknown',
      version: data.version?.number ?? 'unknown',
      distribution: data.version?.distribution,
    };
  }

  async listIndices(): Promise<SearchIndex[]> {
    // _cat with format=json: skips system indices that start with a dot via expand.
    const { data } = await this.http.get<
      Array<{
        index?: string;
        health?: string;
        status?: string;
        'docs.count'?: string;
        'store.size'?: string;
        uuid?: string;
      }>
    >('/_cat/indices', {
      params: {
        format: 'json',
        h: 'index,health,status,docs.count,store.size,uuid',
      },
    });
    return (data ?? [])
      .filter((r) => r.index && !r.index.startsWith('.'))
      .map((r) => ({
        name: r.index,
        health: r.health,
        status: r.status,
        docsCount: r['docs.count'] ? Number(r['docs.count']) : undefined,
        storeSize: r['store.size'],
        uuid: r.uuid,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async getMapping(index: string): Promise<Record<string, unknown>> {
    const { data } = await this.http.get<Record<string, unknown>>(
      `/${encodeURIComponent(index)}/_mapping`,
    );
    return data;
  }

  async search(
    index: string,
    body: Record<string, unknown>,
    opts: { from: number; size: number },
  ): Promise<SearchResponse> {
    const { data } = await this.http.post<{
      took?: number;
      timed_out?: boolean;
      hits?: {
        total?: { value?: number; relation?: string };
        max_score?: number | null;
        hits?: Array<{
          _id?: string;
          _index?: string;
          _score?: number | null;
          _source?: Record<string, unknown>;
        }>;
      };
    }>(`/${encodeURIComponent(index)}/_search`, {
      ...body,
      from: opts.from,
      size: opts.size,
    });

    const hits = data.hits?.hits ?? [];
    return {
      total: data.hits?.total?.value ?? 0,
      totalRelation: data.hits?.total?.relation === 'gte' ? 'gte' : 'eq',
      maxScore: data.hits?.max_score ?? null,
      tookMs: data.took ?? 0,
      timedOut: data.timed_out ?? false,
      hits: hits.map((h) => ({
        id: h._id ?? '',
        index: h._index ?? index,
        score: h._score ?? null,
        source: h._source ?? {},
      })),
    };
  }

  async count(index: string, body?: Record<string, unknown>): Promise<number> {
    const { data } = await this.http.post<{ count?: number }>(
      `/${encodeURIComponent(index)}/_count`,
      body?.query ? { query: body.query } : {},
    );
    return data.count ?? 0;
  }

  async raw(req: RawRestRequest): Promise<RawRestResponse> {
    const started = Date.now();
    const path = req.path.startsWith('/') ? req.path : `/${req.path}`;
    // validateStatus: surface 4xx/5xx bodies to the console (Dev Tools shows the
    // error JSON) instead of throwing; the read-only gate already ran upstream.
    const res = await this.http.request({
      method: req.method,
      url: path,
      data: req.body,
      validateStatus: () => true,
    });
    return {
      status: res.status,
      durationMs: Date.now() - started,
      body: res.data,
    };
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * OpenSearch / Elasticsearch-wire adapter. Talks the REST API over the
 * port-forward tunnel. The security plugin serves HTTPS with a self-signed cert
 * and the loopback host can't match it, so TLS verification is disabled — the
 * endpoint is a trusted in-cluster service reached through a backend-controlled
 * tunnel (same posture as the CLI's internal-TLS skip).
 */
@Injectable()
export class OpenSearchAdapter implements SearchEngineAdapter {
  readonly engines: SearchEngine[] = ['opensearch'];

  connect(params: SearchConnectParams): Promise<SearchConnection> {
    const scheme = params.useTls ? 'https' : 'http';
    const http = axios.create({
      baseURL: `${scheme}://${params.host}:${params.port}`,
      auth: { username: params.username, password: params.password },
      timeout: 30_000,
      httpsAgent: params.useTls
        ? new Agent({ rejectUnauthorized: false })
        : undefined,
      // Large result bodies are fine; let axios buffer the JSON.
      maxContentLength: 64 * 1024 * 1024,
    });
    return Promise.resolve(new OpenSearchConnection(http));
  }
}
