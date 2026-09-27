jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({}));
jest.mock('@octokit/auth-app', () => ({}));

import { ApplicationVersionsService } from './application-versions.service';

const INDEX = `sha256:${'a'.repeat(64)}`;
const AMD64 = `sha256:${'b'.repeat(64)}`;

describe('ApplicationVersionsService — which version is running', () => {
  const apply = (runningRef: string | null) =>
    (
      Object.create(ApplicationVersionsService.prototype) as {
        applyCurrentlyDeployedFromCurrentImageRef: (
          r: any,
          run: string | null,
        ) => any;
      }
    ).applyCurrentlyDeployedFromCurrentImageRef(
      {
        sourceType: 'docker_image',
        currentImageRef: 'traefik/whoami:v1.12.0',
        versions: [
          {
            tag: 'v1.12.0',
            allTags: ['v1.12.0'],
            digest: AMD64,
            isCurrentlyDeployed: false,
            createdAt: '2026-01-01',
          },
          {
            tag: 'v1.11.0',
            allTags: ['v1.11.0'],
            digest: `sha256:${'c'.repeat(64)}`,
            isCurrentlyDeployed: false,
            createdAt: '2025-01-01',
          },
        ],
      },
      runningRef,
    );

  it('marks the declared tag running when the node reports the multi-platform digest', () => {
    const result = apply(`docker.io/traefik/whoami@${INDEX}`);
    expect(
      result.versions.find((v: any) => v.tag === 'v1.12.0').isCurrentlyDeployed,
    ).toBe(true);
    expect(
      result.versions.filter((v: any) => v.isCurrentlyDeployed),
    ).toHaveLength(1);
  });

  it('still trusts the running digest when it matches a listed version', () => {
    const result = apply(`docker.io/traefik/whoami@sha256:${'c'.repeat(64)}`);
    expect(
      result.versions.find((v: any) => v.tag === 'v1.11.0').isCurrentlyDeployed,
    ).toBe(true);
    expect(
      result.versions.filter((v: any) => v.isCurrentlyDeployed),
    ).toHaveLength(1);
  });

  it('prefers the declared tag among tags that share the running digest', () => {
    const result = (
      Object.create(ApplicationVersionsService.prototype) as {
        applyCurrentlyDeployedFromCurrentImageRef: (
          r: any,
          run: string | null,
        ) => any;
      }
    ).applyCurrentlyDeployedFromCurrentImageRef(
      {
        sourceType: 'docker_image',
        currentImageRef: 'traefik/whoami:v1.11.0-amd64',
        versions: [
          {
            tag: 'v1.11',
            allTags: ['v1.11'],
            digest: AMD64,
            isCurrentlyDeployed: false,
            createdAt: '2025-03-13',
          },
          {
            tag: 'v1.11.0-amd64',
            allTags: ['v1.11.0-amd64'],
            digest: AMD64,
            isCurrentlyDeployed: false,
            createdAt: '2025-03-13',
          },
        ],
      },
      `docker.io/traefik/whoami@${AMD64}`,
    );
    expect(
      result.versions
        .filter((v: any) => v.isCurrentlyDeployed)
        .map((v: any) => v.tag),
    ).toEqual(['v1.11.0-amd64']);
  });
});
