import { Injectable } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import * as https from 'node:https';
import {
  SecretListEntry,
  SecretRead,
  SecretVersionMeta,
  SecretsConnectParams,
  SecretsConnection,
  SecretsEngine,
  SecretsEngineAdapter,
  SecretsServerInfo,
} from './secrets-engine';

interface HealthResponse {
  initialized?: boolean;
  sealed?: boolean;
  version?: string;
}

interface KvDataResponse {
  data?: {
    data?: Record<string, string>;
    metadata?: { version?: number; created_time?: string };
  };
}

interface KvMetadataResponse {
  data?: {
    current_version?: number;
    versions?: Record<
      string,
      { created_time?: string; deletion_time?: string; destroyed?: boolean }
    >;
  };
}

// Tag an error so the query layer can surface it as a clean 400.
function clientError(message: string): Error {
  return Object.assign(new Error(message), { clientMessage: message });
}

// Join a KV v2 prefix to the metadata/data path without mangling slashes.
function joinPath(...parts: string[]): string {
  return parts
    .map((p) => p.replaceAll(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
}

/**
 * OpenBao KV v2 session over the Vault-compatible HTTP API. Reads/writes secrets
 * at `<mount>/data/<path>`, lists path prefixes at `<mount>/metadata/<path>`, and
 * exposes version history. The token authenticates every call.
 */
class OpenBaoConnection implements SecretsConnection {
  constructor(
    private readonly http: AxiosInstance,
    private readonly mount: string,
  ) {}

  async serverInfo(): Promise<SecretsServerInfo> {
    const { data } = await this.http.get<HealthResponse>('/v1/sys/health', {
      // sys/health returns non-200 when sealed/standby — read it regardless.
      params: { sealedcode: 200, uninitcode: 200, standbyok: true },
    });
    return {
      version: data.version ?? 'unknown',
      initialized: data.initialized ?? false,
      sealed: data.sealed ?? false,
      mount: this.mount,
    };
  }

  async list(prefix: string): Promise<SecretListEntry[]> {
    const path = joinPath(this.mount, 'metadata', prefix);
    const { data, status } = await this.http.get<{
      data?: { keys?: string[] };
    }>(`/v1/${path}`, { params: { list: 'true' } });
    if (status === 404) return [];
    return (data.data?.keys ?? []).map((k) => ({
      name: k.replace(/\/$/, ''),
      isFolder: k.endsWith('/'),
    }));
  }

  async read(path: string, version?: number): Promise<SecretRead | null> {
    const dataPath = joinPath(this.mount, 'data', path);
    const { data, status } = await this.http.get<KvDataResponse>(
      `/v1/${dataPath}`,
      version ? { params: { version } } : undefined,
    );
    if (status === 404 || !data.data) return null;
    const versions = await this.versionsOf(path);
    return {
      path,
      data: data.data.data ?? {},
      version: data.data.metadata?.version ?? 0,
      createdTime: data.data.metadata?.created_time,
      versions,
    };
  }

  async write(
    path: string,
    payload: Record<string, string>,
  ): Promise<{ version: number }> {
    const dataPath = joinPath(this.mount, 'data', path);
    const { data } = await this.http.post<{ data?: { version?: number } }>(
      `/v1/${dataPath}`,
      { data: payload },
    );
    return { version: data.data?.version ?? 0 };
  }

  async deleteLatest(path: string): Promise<void> {
    await this.http.delete(`/v1/${joinPath(this.mount, 'data', path)}`);
  }

  async undelete(path: string, version: number): Promise<void> {
    await this.http.post(`/v1/${joinPath(this.mount, 'undelete', path)}`, {
      versions: [version],
    });
  }

  async destroy(path: string): Promise<void> {
    await this.http.delete(`/v1/${joinPath(this.mount, 'metadata', path)}`);
  }

  private async versionsOf(path: string): Promise<SecretVersionMeta[]> {
    const metaPath = joinPath(this.mount, 'metadata', path);
    const { data, status } = await this.http.get<KvMetadataResponse>(
      `/v1/${metaPath}`,
    );
    if (status === 404 || !data.data?.versions) return [];
    return Object.entries(data.data.versions)
      .map(([v, meta]) => ({
        version: Number(v),
        createdTime: meta.created_time,
        deleted: !!meta.deletion_time && meta.deletion_time !== '',
        destroyed: !!meta.destroyed,
      }))
      .sort((a, b) => a.version - b.version);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * OpenBao adapter. Talks the Vault-compatible HTTP API over the port-forward
 * with the install's access token. In-cluster the listener is plaintext (TLS is
 * terminated by Flui when exposed), so TLS is off by default.
 */
@Injectable()
export class OpenBaoAdapter implements SecretsEngineAdapter {
  readonly engines: SecretsEngine[] = ['openbao'];

  connect(params: SecretsConnectParams): Promise<SecretsConnection> {
    const scheme = params.useTls ? 'https' : 'http';
    const http = axios.create({
      baseURL: `${scheme}://${params.host}:${params.port}`,
      timeout: 15_000,
      headers: { 'X-Vault-Token': params.token },
      // Accept 404 (treated as "absent") and sealed/standby health codes.
      validateStatus: (s) => (s >= 200 && s < 300) || s === 404,
      ...(params.useTls
        ? { httpsAgent: new https.Agent({ rejectUnauthorized: false }) }
        : {}),
    });
    return Promise.resolve(
      new OpenBaoConnection(http, params.mount ?? 'secret'),
    );
  }
}
