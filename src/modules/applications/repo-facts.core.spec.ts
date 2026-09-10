/**
 * The chain the validation endpoint now runs, end to end and offline: a
 * repository read → cartographer's survey → `RepoFacts` → the checks, against
 * a manifest parsed the way the endpoint parses it.
 *
 * The case that gives the whole piece its reason is the last one: a manifest
 * naming a Dockerfile that is not in the repository used to answer
 * `valid: true` with no warning.
 */

import { repoFactsFrom } from './repo-facts.core';
import type { RepoTreeRead } from './services/repo-tree-reader.service';
import { allChecksFor, type ManifestCheck } from './manifest-repo-checks.core';
import { wouldDeploy } from './manifest-checks.core';
import type { ManifestFacts } from './manifest-checks.core';
import { manifestSelfFacts } from './manifest-self-facts.core';
import { parseApplicationManifest } from './utils/application-manifest.util';

const treeFrom = (contents: Record<string, string>): RepoTreeRead => {
  const files = Object.keys(contents);
  return {
    read: true,
    commitSha: '9f1c0b7a6d5e4c3b2a1908f7e6d5c4b3a2918070',
    ref: 'main',
    scan: {
      root: 'acme/api',
      files,
      truncated: false,
      read: (file: string) => contents[file] ?? null,
      sources: () => files.map((path) => ({ path, content: contents[path] })),
    },
    truncated: false,
    contentComplete: true,
    skipped: { symlinks: 0, oversize: 0, other: 0 },
    bytesRead: Object.values(contents).reduce((n, c) => n + c.length, 0),
    highDensityUnread: [],
  };
};

/** The manifest every official template ships, verbatim in its build block. */
const TEMPLATE_YAML = `kind: Application
apiVersion: flui.cloud/v1beta1
metadata:
  name: my-app
build:
  strategy: dockerfile
  dockerfile: ./Dockerfile
  context: .
deploy:
  port: 3000
  exposure: public
  healthcheck:
    path: /api/health
`;

const REPO = {
  Dockerfile: 'FROM node:22-alpine\nEXPOSE 3000\nCMD ["node", "server.js"]\n',
  'package.json': '{"name":"api","version":"1.0.0"}',
  'server.js':
    "const express = require('express');\nconst app = express();\napp.get('/api/health', (req, res) => res.send('ok'));\napp.listen(3000);\n",
};

const facts = (): ManifestFacts => ({
  clusterFound: true,
  clusterReady: true,
  clusterName: 'control-cluster',
  repositoryConnected: true,
  repoFullName: 'acme/api',
  githubConnected: true,
  registryCredential: true,
  existingApp: null,
  capacity: null,
  exposure: 'public',
  dnsZone: 'example.com',
  fqdn: null,
  targetIsControlCluster: false,
  hasWorkloadCluster: true,
});

const byId = (checks: ManifestCheck[], id: string): ManifestCheck =>
  checks.find((c) => c.id === id)!;

describe('repoFactsFrom', () => {
  it('pins every answer to the commit and states the edge of what was read', () => {
    const repo = repoFactsFrom(treeFrom(REPO));
    expect(repo.read).toBe(true);
    expect(repo.boundary.commitSha).toBe(
      '9f1c0b7a6d5e4c3b2a1908f7e6d5c4b3a2918070',
    );
    expect(repo.boundary.listingComplete).toBe(true);
    expect(repo.boundary.contentComplete).toBe(true);
    expect(repo.boundary.files).toBe(3);
    expect(repo.files).toContain('Dockerfile');
    expect(repo.dockerfiles).toEqual(['Dockerfile']);
  });

  it('carries the port with the line that evidences it, never a default', () => {
    const repo = repoFactsFrom(treeFrom(REPO));
    expect(repo.port?.value).toBe(3000);
    expect(repo.port?.source).toContain('Dockerfile');
  });

  it('finds every Dockerfile in the tree, not only the root one', () => {
    const repo = repoFactsFrom(
      treeFrom({
        ...REPO,
        'services/worker/Dockerfile': 'FROM node:22-alpine\n',
      }),
    );
    expect(repo.dockerfiles).toEqual([
      'Dockerfile',
      'services/worker/Dockerfile',
    ]);
  });
});

describe('the validation the endpoint now runs', () => {
  it('a correct templated manifest raises no fail — the ./Dockerfile and . forms included', () => {
    const manifest = parseApplicationManifest(TEMPLATE_YAML);
    const checks = allChecksFor(
      facts(),
      manifestSelfFacts(manifest),
      repoFactsFrom(treeFrom(REPO)),
    );
    expect(byId(checks, 'repo-dockerfile').status).toBe('pass');
    expect(byId(checks, 'repo-build-context').status).toBe('pass');
    expect(byId(checks, 'repo-port').status).toBe('pass');
    expect(checks.filter((c) => c.status === 'fail')).toEqual([]);
    expect(wouldDeploy(checks)).toBe(true);
  });

  // F15, and the reason this piece exists: schema-valid, repository-wrong.
  it('a manifest naming a Dockerfile the repository does not have fails, with the commit named', () => {
    const manifest = parseApplicationManifest(
      TEMPLATE_YAML.replace(
        'dockerfile: ./Dockerfile',
        'dockerfile: ./docker/Dockerfile.prod',
      ),
    );
    const checks = allChecksFor(
      facts(),
      manifestSelfFacts(manifest),
      repoFactsFrom(treeFrom(REPO)),
    );
    const c = byId(checks, 'repo-dockerfile');
    expect(c.status).toBe('fail');
    expect(c.detail).toContain('docker/Dockerfile.prod');
    expect(c.detail).toContain('9f1c0b7');
    expect(wouldDeploy(checks)).toBe(false);
  });

  it('an invented port and health path warn, each quoting what disagrees', () => {
    const manifest = parseApplicationManifest(
      TEMPLATE_YAML.replace('port: 3000', 'port: 8080').replace(
        'path: /api/health',
        'path: /healthz',
      ),
    );
    const checks = allChecksFor(
      facts(),
      manifestSelfFacts(manifest),
      repoFactsFrom(treeFrom(REPO)),
    );
    expect(byId(checks, 'repo-port').status).toBe('warn');
    expect(byId(checks, 'repo-port').detail).toContain('3000');
    expect(byId(checks, 'repo-health-path').status).toBe('warn');
    expect(byId(checks, 'repo-health-path').detail).toContain('/healthz');
    // Neither is demonstrable, so neither stops a deploy.
    expect(wouldDeploy(checks)).toBe(true);
  });

  it('with no repository read, the answer is the seven installation checks plus currency', () => {
    const manifest = parseApplicationManifest(TEMPLATE_YAML);
    const checks = allChecksFor(facts(), manifestSelfFacts(manifest));
    expect(checks.map((c) => c.id)).toEqual([
      'cluster',
      'repository',
      'registry',
      'capacity',
      'placement',
      'identity',
      'exposure',
      'manifest-currency',
    ]);
  });
});
