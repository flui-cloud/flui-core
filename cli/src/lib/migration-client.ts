import { ApiClient } from './api-client';
import { ConfigStorage } from './config-storage';

export type MigrationType = 'app' | 'db' | 'full';
export type CutoverMode = 'auto' | 'manual';
export type DbMigrationMode = 'live' | 'restore';
export type StagingMode = 'scaled-down' | 'live-fenced';

export interface AppMigration {
  id: string;
  srcAppId: string;
  srcClusterId: string;
  targetClusterId: string;
  cutoverMode: CutoverMode;
  status: string;
  fullMigrationId?: string;
  errorMessage?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt?: string;
}

export interface DbMigration {
  id: string;
  srcAppId: string;
  dstAppId?: string;
  targetClusterId: string;
  mode?: DbMigrationMode;
  cutoverMode: CutoverMode;
  status: string;
  fullMigrationId?: string;
  errorMessage?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt?: string;
}

export interface FullMigration {
  id: string;
  appId: string;
  dbAppId: string;
  targetClusterId: string;
  cutoverMode: CutoverMode;
  stagingMode: StagingMode;
  status: string;
  dbMigrationId?: string;
  appMigrationId?: string;
  errorMessage?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt?: string;
}

export interface CreateAppMigrationInput {
  srcAppId: string;
  targetClusterId: string;
  cutover?: CutoverMode;
}

export interface CreateDbMigrationInput {
  srcAppId: string;
  targetClusterId: string;
  displayName?: string;
  mode?: DbMigrationMode;
  cutover?: CutoverMode;
  verifyRowCounts?: boolean;
  recoveryTargetTime?: string;
}

export interface CreateFullMigrationInput {
  appId: string;
  dbAppId: string;
  targetClusterId: string;
  cutover?: CutoverMode;
  stagingMode?: StagingMode;
}

/**
 * Client for the three migration planes (app-workload, managed-DB, full-app).
 * Each maps 1:1 to a REST resource: `/app-migrations`, `/db-migrations`,
 * `/full-migrations`. `cutover` fires a parked (manual) migration; DELETE is the
 * pre-cutover abort; `destroy-source` reclaims the drained source after cutover.
 */
export class MigrationClient {
  private readonly api: ApiClient;

  constructor(api: ApiClient) {
    this.api = api;
  }

  static fromConfig(): MigrationClient {
    const cfg = new ConfigStorage();
    const apiUrl = cfg.getApiUrlOrThrow();
    const apiKey = cfg.getApiKey();
    if (!apiKey) {
      throw new Error(
        'Not logged in. Run `flui auth login` first or check API key.',
      );
    }
    return new MigrationClient(new ApiClient({ baseUrl: apiUrl, apiKey }));
  }

  // ─── App migration ─────────────────────────────────────────────────────────

  async createAppMigration(
    input: CreateAppMigrationInput,
  ): Promise<AppMigration> {
    return this.api.post('/app-migrations', input);
  }

  async listAppMigrations(): Promise<AppMigration[]> {
    return this.api.get('/app-migrations');
  }

  async getAppMigration(id: string): Promise<AppMigration> {
    return this.api.get(`/app-migrations/${id}`);
  }

  async cutoverAppMigration(id: string): Promise<AppMigration> {
    return this.api.post(`/app-migrations/${id}/cutover`);
  }

  async destroyAppMigrationSource(id: string): Promise<AppMigration> {
    return this.api.post(`/app-migrations/${id}/destroy-source`);
  }

  async abortAppMigration(id: string): Promise<AppMigration> {
    return this.api.delete(`/app-migrations/${id}`);
  }

  // ─── DB migration ──────────────────────────────────────────────────────────

  async createDbMigration(input: CreateDbMigrationInput): Promise<DbMigration> {
    return this.api.post('/db-migrations', input);
  }

  async listDbMigrations(): Promise<DbMigration[]> {
    return this.api.get('/db-migrations');
  }

  async getDbMigration(id: string): Promise<DbMigration> {
    return this.api.get(`/db-migrations/${id}`);
  }

  async cutoverDbMigration(id: string): Promise<DbMigration> {
    return this.api.post(`/db-migrations/${id}/cutover`);
  }

  async abortDbMigration(id: string): Promise<DbMigration> {
    return this.api.delete(`/db-migrations/${id}`);
  }

  // ─── Full-app migration ────────────────────────────────────────────────────

  async createFullMigration(
    input: CreateFullMigrationInput,
  ): Promise<FullMigration> {
    return this.api.post('/full-migrations', input);
  }

  async listFullMigrations(): Promise<FullMigration[]> {
    return this.api.get('/full-migrations');
  }

  async getFullMigration(id: string): Promise<FullMigration> {
    return this.api.get(`/full-migrations/${id}`);
  }

  async cutoverFullMigration(id: string): Promise<FullMigration> {
    return this.api.post(`/full-migrations/${id}/cutover`);
  }

  async destroyFullMigrationSource(id: string): Promise<FullMigration> {
    return this.api.post(`/full-migrations/${id}/destroy-source`);
  }

  async abortFullMigration(id: string): Promise<FullMigration> {
    return this.api.delete(`/full-migrations/${id}`);
  }
}
