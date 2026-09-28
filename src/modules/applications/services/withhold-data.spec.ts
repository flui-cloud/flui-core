jest.mock('@kubernetes/client-node', () => ({}));

import { withholdDataFrom } from './application-access.service';
import { tabsForPermissions } from '../../iam/constants/iam-tabs';
import { permissionsForRole } from '../../iam/constants/iam-roles';

const dto = {
  id: 'a1',
  env: [
    { name: 'DATABASE_HOST', value: 'db.internal' },
    { name: 'API_KEY', value: '****', secret: true },
  ],
};

describe('an application seen without its data', () => {
  it('keeps the names of its variables and sends none of their values', () => {
    const seen = withholdDataFrom(dto, { dataAccess: false });
    expect(seen.env).toEqual([
      { name: 'DATABASE_HOST', value: '', secret: undefined, withheld: true },
      { name: 'API_KEY', value: '', secret: true, withheld: true },
    ]);
    expect(JSON.stringify(seen)).not.toContain('db.internal');
  });

  it('is unchanged for someone who may reach its data', () => {
    expect(withholdDataFrom(dto, { dataAccess: true })).toBe(dto);
  });

  it('keeps what the source is and drops what it carries', () => {
    const seen = withholdDataFrom(
      {
        id: 'a1',
        sourceConfig: {
          type: 'git_build',
          repositoryId: 'r1',
          branch: 'main',
          gitUrl: 'https://x-access-token:ghs_secret@github.com/acme/api.git',
          commitSha: 'abc123',
          framework: 'nestjs',
          buildMode: 'dockerfile',
          subPath: 'apps/api',
          buildPlan: { NPM_TOKEN: 'npm_secret' },
          dockerfile: 'FROM node\nENV API_KEY=inline_secret',
          lastBuildJobId: 'job-1',
        },
      },
      { dataAccess: false },
    );

    expect(seen.sourceConfig).toEqual({
      type: 'git_build',
      repositoryId: 'r1',
      branch: 'main',
      gitUrl: 'https://github.com/acme/api.git',
      commitSha: 'abc123',
      framework: 'nestjs',
      buildMode: 'dockerfile',
      subPath: 'apps/api',
      withheld: true,
    });
    const text = JSON.stringify(seen);
    for (const secret of ['ghs_secret', 'npm_secret', 'inline_secret']) {
      expect(text).not.toContain(secret);
    }
  });

  it('drops registry credentials, chart values and raw manifests', () => {
    const image = withholdDataFrom(
      {
        id: 'a1',
        sourceConfig: {
          type: 'docker_image',
          imageRef: 'ghcr.io/acme/api:1.2.3',
          registryAuth: 'base64-credential',
          pullPolicy: 'Always',
        },
      },
      { dataAccess: false },
    );
    expect(image.sourceConfig).toEqual({
      type: 'docker_image',
      imageRef: 'ghcr.io/acme/api:1.2.3',
      pullPolicy: 'Always',
      withheld: true,
    });

    const chart = withholdDataFrom(
      {
        id: 'a1',
        sourceConfig: {
          type: 'helm_chart',
          repoUrl: 'https://charts.example.com',
          chartName: 'redis',
          chartVersion: '1.0.0',
          valuesYaml: 'password: s3cret',
          valuesOverrides: { password: 's3cret' },
        },
      },
      { dataAccess: false },
    );
    expect(JSON.stringify(chart)).not.toContain('s3cret');

    const raw = withholdDataFrom(
      {
        id: 'a1',
        sourceConfig: {
          type: 'raw_manifest',
          manifests: [{ name: 'm', yaml: 'kind: Secret', order: 0 }],
          templateVariables: { TOKEN: 't0ken' },
        },
      },
      { dataAccess: false },
    );
    expect(raw.sourceConfig).toEqual({ type: 'raw_manifest', withheld: true });
  });

  it('leaves the source alone for someone who may reach its data', () => {
    const full = {
      id: 'a1',
      sourceConfig: { type: 'git_build', buildPlan: { A: 'b' } },
    };
    expect(withholdDataFrom(full, { dataAccess: true })).toBe(full);
  });

  it('offers the platform operator no tab that renders the application’s data', () => {
    const tabs = tabsForPermissions(
      new Set(permissionsForRole('platform_operator')),
    );
    expect(tabs).toEqual(
      expect.arrayContaining(['overview', 'monitoring', 'revisions', 'dns']),
    );
    for (const dataTab of [
      'logs',
      'builds',
      'configuration',
      'clients',
      'schedules',
      'gateway',
    ]) {
      expect(tabs).not.toContain(dataTab);
    }
  });

  it('does not offer the gateway tab without data:access, since its routes are doors', () => {
    expect(
      tabsForPermissions(new Set(['app:read', 'app:write'])),
    ).not.toContain('gateway');
    expect(
      tabsForPermissions(new Set(['app:read', 'app:write', 'data:access'])),
    ).toContain('gateway');
  });

  it('still offers a viewer the logs', () => {
    expect(tabsForPermissions(new Set(permissionsForRole('viewer')))).toContain(
      'logs',
    );
  });
});
