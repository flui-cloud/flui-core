import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { ApiTokenRepository } from '../../access/repositories/api-token.repository';
import { CredentialPurpose } from '../../access/enums/credential-purpose.enum';
import { KeyStorageService } from '../../access/services/key-storage.service';
import { CredentialType } from '../../management/entities/credentials.entity';
import { CloudProvider } from '../../providers/enums/cloud-provider.enum';
import { GenericS3Backend } from '../../storage/implementations/generic-s3.backend';
import { StorageBackendProvider } from '../../storage/enums/storage-backend-provider.enum';
import { RegistryStorageInput } from '../services/registry-storage.service';

const API = 'https://api.scaleway.com';
const PERMISSION_WAIT_MS = 5 * 60_000;
const PERMISSION_POLL_MS = 10_000;

export const scalewayS3Endpoint = (region: string): string =>
  `https://s3.${region}.scw.cloud`;

type Fetch = typeof fetch;

/**
 * A bucket for the instance registry on Scaleway, reached by a key that can do
 * nothing else.
 *
 * Scaleway grants Object Storage per project, never per bucket, and a bucket
 * policy cannot deny anything. So the registry gets a project of its own: an
 * IAM application whose only policy is Object Storage on that project, and a
 * key whose preferred project is that one. The key never reaches compute, nor
 * the default project where the backups live. The account key is used here to
 * create those, and never leaves the API.
 */
@Injectable()
export class ScalewayRegistryStorageProvisioner {
  private readonly logger = new Logger(ScalewayRegistryStorageProvisioner.name);
  fetchImpl: Fetch = fetch;
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms));

  constructor(
    private readonly apiTokens: ApiTokenRepository,
    private readonly keyStorage: KeyStorageService,
    private readonly s3: GenericS3Backend,
  ) {}

  async provision(region: string): Promise<RegistryStorageInput> {
    const owner = await this.ownerKey();
    const suffix = randomBytes(4).toString('hex');
    const name = `flui-registry-${suffix}`;
    const created: Record<string, string> = {};
    try {
      const organizationId = await this.organizationOf(owner);
      created.organizationId = organizationId;

      const project = await this.call<{ id: string }>(
        owner,
        'POST',
        '/account/v3/projects',
        {
          name,
          organization_id: organizationId,
          description: 'Images of the Flui instance registry',
        },
      );
      created.projectId = project.id;

      const application = await this.call<{ id: string }>(
        owner,
        'POST',
        '/iam/v1alpha1/applications',
        {
          name,
          organization_id: organizationId,
          description: 'The Flui instance registry',
        },
      );
      created.applicationId = application.id;

      const policy = await this.call<{ id: string }>(
        owner,
        'POST',
        '/iam/v1alpha1/policies',
        {
          name,
          organization_id: organizationId,
          application_id: application.id,
          rules: [
            {
              permission_set_names: ['ObjectStorageFullAccess'],
              project_ids: [project.id],
            },
          ],
        },
      );
      created.policyId = policy.id;

      const key = await this.call<{ access_key: string; secret_key: string }>(
        owner,
        'POST',
        '/iam/v1alpha1/api-keys',
        {
          application_id: application.id,
          default_project_id: project.id,
          description: 'Flui instance registry',
        },
      );
      created.accessKey = key.access_key;

      const storage: RegistryStorageInput = {
        provider: StorageBackendProvider.SCALEWAY_OBJECT_STORAGE,
        endpoint: scalewayS3Endpoint(region),
        region,
        bucket: name,
        prefix: 'zot',
        forcePathStyle: false,
        accessKey: key.access_key,
        secretKey: key.secret_key,
        providerResources: { ...created },
      };
      await this.createBucketOnceAllowed(storage);
      return storage;
    } catch (error) {
      await this.teardown(created, owner).catch((error_: unknown) =>
        this.logger.warn(
          `Could not remove what was created on Scaleway: ${describe(error_)}`,
        ),
      );
      throw error;
    }
  }

  /**
   * Removes what `provision` created. The bucket must already be empty and
   * gone: a project holding a bucket cannot be deleted.
   */
  async teardown(
    resources: Record<string, string>,
    owner?: { accessKey: string; secretKey: string },
  ): Promise<void> {
    const key = owner ?? (await this.ownerKey());
    const steps: Array<[string, string | undefined]> = [
      ['/iam/v1alpha1/api-keys/', resources.accessKey],
      ['/iam/v1alpha1/policies/', resources.policyId],
      ['/iam/v1alpha1/applications/', resources.applicationId],
      ['/account/v3/projects/', resources.projectId],
    ];
    for (const [path, id] of steps) {
      if (!id) continue;
      await this.call(key, 'DELETE', `${path}${id}`, undefined, [404]);
    }
  }

  /**
   * The organization the account key belongs to. The key itself does not
   * always say; its default project always does.
   */
  private async organizationOf(owner: {
    accessKey: string;
    secretKey: string;
  }): Promise<string> {
    const key = await this.call<{
      organization_id?: string;
      default_project_id?: string;
    }>(owner, 'GET', `/iam/v1alpha1/api-keys/${owner.accessKey}`);
    if (key.organization_id) return key.organization_id;
    if (!key.default_project_id) {
      throw new BadRequestException(
        'The Scaleway key this installation holds has no default project, so its organization cannot be found',
      );
    }
    const project = await this.call<{ organization_id: string }>(
      owner,
      'GET',
      `/account/v3/projects/${key.default_project_id}`,
    );
    return project.organization_id;
  }

  /** Scaleway applies a new Object Storage policy within about five minutes. */
  private async createBucketOnceAllowed(
    storage: RegistryStorageInput,
  ): Promise<void> {
    const deadline = Date.now() + PERMISSION_WAIT_MS;
    for (;;) {
      try {
        await this.s3.ensureBucket({
          provider: storage.provider,
          endpoint: storage.endpoint,
          region: storage.region,
          bucket: storage.bucket,
          accessKey: storage.accessKey,
          secretKey: storage.secretKey,
          forcePathStyle: storage.forcePathStyle,
        });
        return;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await this.sleep(PERMISSION_POLL_MS);
      }
    }
  }

  private async ownerKey(): Promise<{ accessKey: string; secretKey: string }> {
    const tokens = await this.apiTokens.findByProviderAndPurpose(
      CloudProvider.SCALEWAY,
      CredentialPurpose.COMPUTE,
    );
    const token = tokens?.find(
      (t) => t.credential_type === CredentialType.ACCESS_KEY_SECRET,
    );
    if (!token?.encrypted_access_key) {
      throw new BadRequestException(
        'Connect Scaleway first: the registry bucket is created with the Scaleway key this installation already holds',
      );
    }
    return {
      accessKey: this.keyStorage.decryptKeyFromString(
        token.encrypted_access_key,
      ),
      secretKey: this.keyStorage.decryptKeyFromString(token.encrypted_token),
    };
  }

  private async call<T>(
    key: { secretKey: string },
    method: string,
    path: string,
    body?: unknown,
    tolerated: number[] = [],
  ): Promise<T> {
    const response = await this.fetchImpl(`${API}${path}`, {
      method,
      headers: {
        'X-Auth-Token': key.secretKey,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (tolerated.includes(response.status)) return undefined as T;
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `Scaleway ${method} ${path.replace(/[A-Z0-9]{20}$/, '…')} answered ${response.status}: ${detail.slice(0, 200)}`,
      );
    }
    return (response.status === 204 ? undefined : await response.json()) as T;
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : JSON.stringify(error);
}
