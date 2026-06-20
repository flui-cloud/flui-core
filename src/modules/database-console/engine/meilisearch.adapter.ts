import { Injectable } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import {
  FulltextConnectParams,
  FulltextConnection,
  FulltextEngine,
  FulltextEngineAdapter,
  FulltextIndex,
  FulltextSearchParams,
  FulltextSearchResult,
  FulltextServerInfo,
} from './fulltext-engine';
import { RawRestRequest } from './raw-rest';

class MeilisearchConnection implements FulltextConnection {
  constructor(private readonly http: AxiosInstance) {}

  async serverInfo(): Promise<FulltextServerInfo> {
    const [version, stats] = await Promise.all([
      this.http.get<{ pkgVersion?: string }>('/version'),
      this.http
        .get<{
          databaseSize?: number;
          indexes?: Record<string, unknown>;
        }>('/stats')
        .catch(() => ({
          data: {} as {
            databaseSize?: number;
            indexes?: Record<string, unknown>;
          },
        })),
    ]);
    return {
      version: version.data.pkgVersion ?? 'unknown',
      databaseSize: stats.data.databaseSize,
      indexCount: stats.data.indexes
        ? Object.keys(stats.data.indexes).length
        : 0,
    };
  }

  async listIndexes(): Promise<FulltextIndex[]> {
    const { data } = await this.http.get<{
      results?: Array<{ uid: string; primaryKey?: string | null }>;
    }>('/indexes', { params: { limit: 1000 } });
    const stats = await this.http
      .get<{ indexes?: Record<string, { numberOfDocuments?: number }> }>(
        '/stats',
      )
      .then((r) => r.data.indexes ?? {})
      .catch(() => ({}) as Record<string, { numberOfDocuments?: number }>);
    return (data.results ?? [])
      .map((i) => ({
        uid: i.uid,
        primaryKey: i.primaryKey ?? undefined,
        numberOfDocuments: stats[i.uid]?.numberOfDocuments,
      }))
      .sort((a, b) => a.uid.localeCompare(b.uid));
  }

  async search(
    index: string,
    params: FulltextSearchParams,
  ): Promise<FulltextSearchResult> {
    const body: Record<string, unknown> = {
      q: params.q ?? '',
      limit: params.limit ?? 20,
      offset: params.offset ?? 0,
    };
    if (params.filter) body.filter = params.filter;
    const { data } = await this.http.post<{
      hits?: Record<string, unknown>[];
      query?: string;
      estimatedTotalHits?: number;
      totalHits?: number;
      processingTimeMs?: number;
      limit?: number;
      offset?: number;
    }>(`/indexes/${encodeURIComponent(index)}/search`, body);
    return {
      query: data.query ?? params.q ?? '',
      hits: data.hits ?? [],
      estimatedTotalHits: data.estimatedTotalHits ?? data.totalHits ?? 0,
      processingTimeMs: data.processingTimeMs ?? 0,
      limit: data.limit ?? params.limit ?? 20,
      offset: data.offset ?? params.offset ?? 0,
    };
  }

  async raw(
    req: RawRestRequest,
  ): Promise<{ status: number; durationMs: number; body: unknown }> {
    const started = Date.now();
    const path = req.path.startsWith('/') ? req.path : `/${req.path}`;
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
 * Meilisearch adapter — talks the native REST API over the port-forward tunnel,
 * authenticating with the install's master key as a Bearer token.
 */
@Injectable()
export class MeilisearchAdapter implements FulltextEngineAdapter {
  readonly engines: FulltextEngine[] = ['meilisearch'];

  connect(params: FulltextConnectParams): Promise<FulltextConnection> {
    const http = axios.create({
      baseURL: `http://${params.host}:${params.port}`,
      headers: params.apiKey
        ? { Authorization: `Bearer ${params.apiKey}` }
        : undefined,
      timeout: 30_000,
      maxContentLength: 64 * 1024 * 1024,
    });
    return Promise.resolve(new MeilisearchConnection(http));
  }
}
