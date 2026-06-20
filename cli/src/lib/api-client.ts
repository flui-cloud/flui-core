import axios, { AxiosInstance, AxiosError } from 'axios';
import * as https from 'node:https';
import { Readable } from 'node:stream';
import { Injectable } from '@nestjs/common';
import { NodeSizeDto } from '../../../src/modules/providers/dto/node-size.dto';

/**
 * HTTP client for Flui API communication
 * Handles authentication, error handling, and request/response formatting
 */

export interface ApiClientConfig {
  baseUrl: string;
  timeout?: number;
  apiKey?: string;
}

export class ApiError extends Error {
  statusCode?: number;
  details?: any;

  constructor(message: string, statusCode?: number, details?: any) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

@Injectable()
export class ApiClient {
  private readonly client: AxiosInstance;
  private readonly baseUrl: string;

  constructor(config: ApiClientConfig) {
    this.baseUrl = config.baseUrl;
    this.client = axios.create({
      baseURL: config.baseUrl,
      timeout: config.timeout || 30000,
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    });

    // Add response interceptor for error handling
    this.client.interceptors.response.use(
      (response) => response,
      (error: AxiosError) => {
        return Promise.reject(this.normalizeError(error));
      },
    );
  }

  /**
   * Normalize Axios errors to ApiError format
   */
  private normalizeError(error: AxiosError): ApiError {
    if (error.response) {
      const data = error.response.data as any;
      return new ApiError(
        data?.message || error.message,
        error.response.status,
        data,
      );
    } else if (error.request) {
      return new ApiError(
        'API server not reachable. Please check the API URL and network connection.',
        undefined,
        error.message,
      );
    } else {
      return new ApiError(error.message);
    }
  }

  /**
   * GET request
   */
  async get<T>(path: string): Promise<T> {
    const response = await this.client.get<T>(path);
    return response.data;
  }

  /**
   * POST request
   */
  async post<T>(path: string, data?: any): Promise<T> {
    const response = await this.client.post<T>(path, data);
    return response.data;
  }

  /**
   * PUT request
   */
  async put<T>(path: string, data?: any): Promise<T> {
    const response = await this.client.put<T>(path, data);
    return response.data;
  }

  /**
   * PATCH request
   */
  async patch<T>(path: string, data?: any): Promise<T> {
    const response = await this.client.patch<T>(path, data);
    return response.data;
  }

  /**
   * DELETE request
   */
  async delete<T>(path: string, config?: { data?: unknown }): Promise<T> {
    const response = await this.client.delete<T>(path, config);
    return response.data;
  }

  /**
   * GET returning the raw response body as a stream (no timeout) — for large downloads
   * such as a database dump. Caller pipes it to a file/stdout.
   */
  async getStream(path: string): Promise<NodeJS.ReadableStream> {
    try {
      const response = await this.client.get(path, {
        responseType: 'stream',
        timeout: 0,
      });
      return response.data as NodeJS.ReadableStream;
    } catch (err) {
      // On an error status the body arrives as a stream (responseType=stream); read it so the
      // server's JSON { message } surfaces instead of a generic "status code 500".
      const e = err as ApiError;
      const body = e.details as { on?: unknown } | undefined;
      if (body && typeof body.on === 'function') {
        const text = await new Promise<string>((resolve) => {
          let buf = '';
          const s = body as NodeJS.ReadableStream;
          s.on('data', (c: Buffer) => (buf += c.toString()));
          s.on('end', () => resolve(buf));
          s.on('error', () => resolve(buf));
        });
        let message = text || e.message;
        try {
          message = (JSON.parse(text) as { message?: string }).message ?? text;
        } catch {
          /* not JSON — use raw text */
        }
        throw new ApiError(message, e.statusCode);
      }
      throw err;
    }
  }

  /**
   * POST a stream/buffer body as application/octet-stream (no timeout) — for large uploads
   * such as a database restore.
   */
  async postStream<T>(path: string, body: Readable | Buffer): Promise<T> {
    const response = await this.client.post<T>(path, body, {
      headers: { 'Content-Type': 'application/octet-stream' },
      timeout: 0,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
    return response.data;
  }

  /**
   * Get base URL
   */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Get available node sizes/server types for a provider
   */
  async getNodeSizes(
    provider: string,
    region?: string,
    skipCache = false,
  ): Promise<NodeSizeDto[]> {
    const params = new URLSearchParams();
    if (region) {
      params.append('region', region);
    }
    if (skipCache) {
      params.append('skipCache', 'true');
    }

    const queryString = params.toString();
    const qs = queryString ? `?${queryString}` : '';
    const path = `/management/providers/${provider}/node-sizes${qs}`;

    return this.get<NodeSizeDto[]>(path);
  }

  /**
   * Clear node sizes cache for a provider
   */
  async clearNodeSizesCache(provider: string): Promise<void> {
    const path = `/management/cache/providers/${provider}/node-sizes`;
    return this.delete<void>(path);
  }
}
