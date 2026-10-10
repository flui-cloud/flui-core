jest.mock('@kubernetes/client-node', () => ({}));

import { BadRequestException } from '@nestjs/common';
import { CredentialType } from '../../management/entities/credentials.entity';
import { ScalewayRegistryStorageProvisioner } from './scaleway-registry-storage.provisioner';

const OWNER_ACCESS = 'SCWOWNERACCESSKEY123';
const OWNER_SECRET = 'owner-secret-never-leaves';

function harness(
  opts: {
    failOn?: string;
    bucketDenials?: number;
    noKey?: boolean;
    keyWithoutOrg?: boolean;
  } = {},
) {
  const calls: Array<{
    method: string;
    path: string;
    body?: any;
    token: string;
  }> = [];
  const buckets: Array<Record<string, unknown>> = [];
  let denials = opts.bucketDenials ?? 0;
  const provisioner = new ScalewayRegistryStorageProvisioner(
    {
      findByProviderAndPurpose: async () =>
        opts.noKey
          ? []
          : [
              {
                credential_type: CredentialType.ACCESS_KEY_SECRET,
                encrypted_access_key: `enc:${OWNER_ACCESS}`,
                encrypted_token: `enc:${OWNER_SECRET}`,
              },
            ],
    } as never,
    { decryptKeyFromString: (v: string) => v.slice(4) } as never,
    {
      ensureBucket: async (creds: Record<string, unknown>) => {
        if (denials-- > 0) throw new Error('AccessDenied');
        buckets.push(creds);
      },
    } as never,
  );
  provisioner.sleep = async () => undefined;
  provisioner.fetchImpl = (async (url: string, init: RequestInit) => {
    const path = url.replace('https://api.scaleway.com', '');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({
      method: String(init.method),
      path,
      body,
      token: (init.headers as any)['X-Auth-Token'],
    });
    if (opts.failOn && path.startsWith(opts.failOn) && init.method === 'POST') {
      return new Response('boom', { status: 500 });
    }
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    const replies: Record<string, unknown> = {
      [`/iam/v1alpha1/api-keys/${OWNER_ACCESS}`]: opts.keyWithoutOrg
        ? { default_project_id: 'proj-default' }
        : { organization_id: 'org-1' },
      '/account/v3/projects/proj-default': { organization_id: 'org-1' },
      '/account/v3/projects': { id: 'proj-reg' },
      '/iam/v1alpha1/applications': { id: 'app-reg' },
      '/iam/v1alpha1/policies': { id: 'pol-reg' },
      '/iam/v1alpha1/api-keys': {
        access_key: 'SCWREGISTRYKEY000001',
        secret_key: 'registry-secret',
      },
    };
    return Response.json(replies[path] ?? {});
  }) as never;
  return { provisioner, calls, buckets };
}

describe('a registry bucket on Scaleway, reached by a key that can do nothing else', () => {
  it('gives the registry its own project, Object Storage only, and a key preferring that project', async () => {
    const { provisioner, calls, buckets } = harness();
    const storage = await provisioner.provision('fr-par');

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET /iam/v1alpha1/api-keys/${OWNER_ACCESS}`,
      'POST /account/v3/projects',
      'POST /iam/v1alpha1/applications',
      'POST /iam/v1alpha1/policies',
      'POST /iam/v1alpha1/api-keys',
    ]);
    const policy = calls.find((c) => c.path === '/iam/v1alpha1/policies')!.body;
    expect(policy).toMatchObject({
      application_id: 'app-reg',
      organization_id: 'org-1',
    });
    expect(policy.rules).toEqual([
      {
        permission_set_names: ['ObjectStorageFullAccess'],
        project_ids: ['proj-reg'],
      },
    ]);
    expect(
      calls.find((c) => c.path === '/iam/v1alpha1/api-keys')!.body,
    ).toMatchObject({
      application_id: 'app-reg',
      default_project_id: 'proj-reg',
    });

    expect(storage).toMatchObject({
      endpoint: 'https://s3.fr-par.scw.cloud',
      region: 'fr-par',
      accessKey: 'SCWREGISTRYKEY000001',
      secretKey: 'registry-secret',
      providerResources: {
        projectId: 'proj-reg',
        applicationId: 'app-reg',
        policyId: 'pol-reg',
        accessKey: 'SCWREGISTRYKEY000001',
      },
    });
    expect(buckets[0]).toMatchObject({
      accessKey: 'SCWREGISTRYKEY000001',
      bucket: storage.bucket,
    });
    expect(JSON.stringify(storage)).not.toContain(OWNER_SECRET);
    expect(JSON.stringify(buckets)).not.toContain(OWNER_SECRET);
  });

  it('waits for Scaleway to apply the new policy before using the key', async () => {
    const { provisioner, buckets } = harness({ bucketDenials: 3 });
    await provisioner.provision('nl-ams');
    expect(buckets).toHaveLength(1);
  });

  it('removes what it created when a step fails, and says which', async () => {
    const { provisioner, calls } = harness({
      failOn: '/iam/v1alpha1/policies',
    });
    await expect(provisioner.provision('fr-par')).rejects.toThrow(
      /policies answered 500/,
    );
    expect(
      calls.filter((c) => c.method === 'DELETE').map((c) => c.path),
    ).toEqual([
      '/iam/v1alpha1/applications/app-reg',
      '/account/v3/projects/proj-reg',
    ]);
  });

  it('asks for Scaleway to be connected when the installation holds no key', async () => {
    const { provisioner } = harness({ noKey: true });
    await expect(provisioner.provision('fr-par')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('finds the organization through the default project when the key does not say', async () => {
    const { provisioner, calls } = harness({ keyWithoutOrg: true });
    await provisioner.provision('fr-par');
    expect(calls[1]).toMatchObject({
      method: 'GET',
      path: '/account/v3/projects/proj-default',
    });
    expect(
      calls.find(
        (c) => c.path === '/account/v3/projects' && c.method === 'POST',
      )!.body.organization_id,
    ).toBe('org-1');
  });
});
