import { ConfigService } from '@nestjs/config';
import { OpenStackConfig } from '@flui-cloud/infra';
import { FluiOpenStackClient } from './openstack-volumes-client';

const DEFAULT_AUTH_URL = 'https://auth.cloud.ovh.net/v3';
const DEFAULT_DOMAIN = 'Default';

interface KeystoneProject {
  id: string;
  name: string;
  enabled: boolean;
}

/**
 * Keystone won't scope an auth request to a project it hasn't been told about
 * yet, so we authenticate unscoped first and list the projects the credential
 * can reach, then use that project to build the real (scoped) client. OVH
 * issues one project per OpenStack user by default — mirrors how
 * ScalewayIamAdapter derives a default project id from an access key alone.
 */
async function resolveOvhProjectId(
  authUrl: string,
  username: string,
  password: string,
  userDomain: string,
): Promise<string> {
  const base = authUrl.replace(/\/$/, '');
  const res = await fetch(`${base}/auth/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      auth: {
        identity: {
          methods: ['password'],
          password: {
            user: { name: username, domain: { name: userDomain }, password },
          },
        },
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 401) {
      throw new Error(
        'OVH OpenStack credentials were refused (invalid username or password).',
      );
    }
    throw new Error(
      `OVH OpenStack authentication failed: HTTP ${res.status} ${text.slice(0, 200)}`,
    );
  }
  const token = res.headers.get('x-subject-token');
  if (!token)
    throw new Error('OVH OpenStack authentication returned no token.');

  const projectsRes = await fetch(`${base}/auth/projects`, {
    headers: { 'x-auth-token': token, accept: 'application/json' },
  });
  if (!projectsRes.ok) {
    throw new Error(
      `Could not list OVH OpenStack projects: HTTP ${projectsRes.status}`,
    );
  }
  const body = (await projectsRes.json()) as { projects: KeystoneProject[] };
  const projects = (body.projects ?? []).filter((p) => p.enabled);
  if (projects.length === 0) {
    throw new Error('This OVH OpenStack user has no enabled project.');
  }
  if (projects.length > 1) {
    throw new Error(
      `This OVH OpenStack user has access to ${projects.length} projects; Flui expects exactly one per credential.`,
    );
  }
  return projects[0].id;
}

/**
 * Builds a fresh, scoped OpenStackClient from a raw username/password — always
 * re-resolved, never cached, so a rotated credential takes effect on the next
 * call without a restart (same freshness guarantee as Hetzner/Scaleway).
 */
export async function buildOvhOpenStackClient(
  configService: ConfigService,
  username: string,
  password: string,
): Promise<FluiOpenStackClient> {
  const authUrl = configService.get<string>(
    'OVH_OS_AUTH_URL',
    DEFAULT_AUTH_URL,
  );
  const userDomain = configService.get<string>(
    'OVH_OS_USER_DOMAIN_NAME',
    DEFAULT_DOMAIN,
  );
  const projectDomain = configService.get<string>(
    'OVH_OS_PROJECT_DOMAIN_NAME',
    DEFAULT_DOMAIN,
  );
  const defaultRegion = configService.get<string>('OVH_OS_REGION_NAME');

  const projectId = await resolveOvhProjectId(
    authUrl,
    username,
    password,
    userDomain,
  );

  const config: OpenStackConfig = {
    authUrl,
    username,
    password,
    userDomain,
    projectId,
    projectDomain,
    defaultRegion,
  };
  return new FluiOpenStackClient(config);
}
