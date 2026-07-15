import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import * as https from 'node:https';
import { ClustersService } from '../../infrastructure/clusters/clusters.service';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { ResolvedSecretsConnection } from '../interfaces/secrets-connection';

const TOKEN_KEY = 'OPENBAO_TOKEN';
const UNSEAL_KEY = 'BAO_UNSEAL_KEY';

export interface UnsealReconcileResult {
  initialized: boolean;
  sealed: boolean;
  unsealed: boolean;
  reason: 'uninitialized' | 'already-unsealed' | 'no-key' | 'unsealed';
}

function clientError(message: string): Error {
  return Object.assign(new Error(message), { clientMessage: message });
}

/**
 * Lazily makes an OpenBao install usable, entirely from this module (no coupling
 * into the catalog installer): on first console access it initialises the server
 * (1 unseal key / threshold 1), persists the root token + unseal key into the
 * install's K8s Secret, unseals it, and enables the KV v2 engine. On later access
 * after a restart it re-unseals from the stored key. Returns the access token.
 * Idempotent.
 */
@Injectable()
export class SecretsBootstrapService {
  private readonly logger = new Logger(SecretsBootstrapService.name);

  constructor(
    private readonly clusters: ClustersService,
    private readonly kubernetes: KubernetesService,
  ) {}

  async ensureReady(
    resolved: ResolvedSecretsConnection,
    localPort: number,
  ): Promise<string> {
    const http = this.client(resolved, localPort);
    const kubeconfig = await this.clusters.getKubeconfig(
      resolved.target.clusterId,
    );
    const secretName = `${resolved.slug}-secret`;
    const ns = resolved.target.namespace;

    const health = await http.get('/v1/sys/health', {
      params: { uninitcode: 200, sealedcode: 200, standbyok: true },
    });

    if (!health.data?.initialized) {
      return this.initialise(http, kubeconfig, ns, secretName, resolved.mount);
    }

    const stored = await this.readSecret(kubeconfig, ns, secretName);
    const token = stored[TOKEN_KEY];
    if (!token) {
      throw clientError(
        'OpenBao is initialised but no access token is stored — the install may need to be recreated.',
      );
    }
    if (health.data?.sealed) {
      const key = stored[UNSEAL_KEY];
      if (!key) {
        throw clientError(
          'OpenBao is sealed and no unseal key is stored — cannot auto-unseal.',
        );
      }
      await this.expect(http.post('/v1/sys/unseal', { key }), 'unseal');
    }
    await this.ensureKvMount(http, token, resolved.mount);
    return token;
  }

  /**
   * System reconcile (no console access): re-unseal an already-initialised
   * install from its stored key. Never initialises — an uninitialised install
   * has no key and no data yet, so it is left for the lazy console bootstrap.
   * Used by the auto-unseal scheduler so a pod restart self-heals without a user
   * opening the console. Idempotent.
   */
  async reconcileUnseal(
    resolved: ResolvedSecretsConnection,
    localPort: number,
  ): Promise<UnsealReconcileResult> {
    const http = this.client(resolved, localPort);
    const health = await http.get('/v1/sys/health', {
      params: { uninitcode: 200, sealedcode: 200, standbyok: true },
    });
    if (!health.data?.initialized) {
      return {
        initialized: false,
        sealed: false,
        unsealed: false,
        reason: 'uninitialized',
      };
    }
    if (!health.data?.sealed) {
      return {
        initialized: true,
        sealed: false,
        unsealed: false,
        reason: 'already-unsealed',
      };
    }
    const kubeconfig = await this.clusters.getKubeconfig(
      resolved.target.clusterId,
    );
    const stored = await this.readSecret(
      kubeconfig,
      resolved.target.namespace,
      `${resolved.slug}-secret`,
    );
    const key = stored[UNSEAL_KEY];
    if (!key) {
      return {
        initialized: true,
        sealed: true,
        unsealed: false,
        reason: 'no-key',
      };
    }
    await this.expect(http.post('/v1/sys/unseal', { key }), 'unseal');
    return {
      initialized: true,
      sealed: true,
      unsealed: true,
      reason: 'unsealed',
    };
  }

  private async initialise(
    http: AxiosInstance,
    kubeconfig: string,
    ns: string,
    secretName: string,
    mount: string,
  ): Promise<string> {
    const init = await this.expect(
      http.post('/v1/sys/init', { secret_shares: 1, secret_threshold: 1 }),
      'init',
    );
    const token = init.data?.root_token as string;
    const key = (init.data?.keys as string[])?.[0];
    if (!token || !key)
      throw clientError('OpenBao init returned no key/token.');
    // Persist before unsealing so the credentials are never lost.
    await this.kubernetes.patchSecret(kubeconfig, ns, secretName, {
      [TOKEN_KEY]: token,
      [UNSEAL_KEY]: key,
    });
    await this.expect(http.post('/v1/sys/unseal', { key }), 'unseal');
    await this.ensureKvMount(http, token, mount);
    this.logger.log(`OpenBao initialised + unsealed (secret ${secretName})`);
    return token;
  }

  // Enable the KV v2 engine at the mount; a 400 "path is already in use" is fine.
  private async ensureKvMount(
    http: AxiosInstance,
    token: string,
    mount: string,
  ): Promise<void> {
    const res = await http.post(
      `/v1/sys/mounts/${mount}`,
      { type: 'kv', options: { version: '2' } },
      { headers: { 'X-Vault-Token': token } },
    );
    if (res.status === 204 || res.status === 200) return;
    const msg = JSON.stringify(res.data ?? '');
    if (res.status === 400 && /already in use|existing mount/i.test(msg))
      return;
    throw clientError(`Could not enable KV v2 at ${mount}/: ${msg}`);
  }

  private async readSecret(
    kubeconfig: string,
    ns: string,
    name: string,
  ): Promise<Record<string, string>> {
    const secret = await this.kubernetes
      .getResource(kubeconfig, 'Secret', name, ns)
      .catch(() => undefined);
    const data = (secret?.data as Record<string, string>) ?? {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(data)) {
      out[k] = Buffer.from(v, 'base64').toString('utf8');
    }
    return out;
  }

  private async expect<T extends { status: number; data?: unknown }>(
    p: Promise<T>,
    op: string,
  ): Promise<T> {
    const res = await p;
    if (res.status >= 200 && res.status < 300) return res;
    throw clientError(
      `OpenBao ${op} failed (HTTP ${res.status}): ${JSON.stringify(res.data ?? '')}`,
    );
  }

  private client(
    resolved: ResolvedSecretsConnection,
    localPort: number,
  ): AxiosInstance {
    const scheme = resolved.useTls ? 'https' : 'http';
    return axios.create({
      baseURL: `${scheme}://127.0.0.1:${localPort}`,
      timeout: 15_000,
      validateStatus: () => true,
      ...(resolved.useTls
        ? { httpsAgent: new https.Agent({ rejectUnauthorized: false }) }
        : {}),
    });
  }
}
