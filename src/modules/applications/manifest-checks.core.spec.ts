import {
  checksFor,
  ManifestFacts,
  wouldDeploy,
  type ManifestCheck,
} from './manifest-checks.core';

const facts = (over: Partial<ManifestFacts> = {}): ManifestFacts => ({
  clusterFound: true,
  clusterReady: true,
  clusterName: 'control-cluster',
  repositoryConnected: true,
  repoFullName: 'acme/api',
  githubConnected: true,
  registryCredential: true,
  existingApp: null,
  capacity: {
    fits: true,
    requiredCpuMc: 250,
    requiredMemoryMi: 256,
    availableCpuMc: 1800,
    availableMemoryMi: 4096,
  },
  exposure: 'public',
  dnsZone: 'example.com',
  fqdn: null,
  targetIsControlCluster: false,
  hasWorkloadCluster: true,
  ...over,
});

const byId = (checks: ManifestCheck[], id: string): ManifestCheck =>
  checks.find((c) => c.id === id)!;

describe('what only the installation can say about a manifest', () => {
  it('lets a manifest through when every side of the installation is ready', () => {
    const checks = checksFor(facts());
    expect(wouldDeploy(checks)).toBe(true);
    expect(checks.map((c) => c.status)).not.toContain('fail');
  });

  it('refuses a cluster that does not exist here', () => {
    const checks = checksFor(facts({ clusterFound: false }));
    expect(byId(checks, 'cluster').status).toBe('fail');
    expect(wouldDeploy(checks)).toBe(false);
  });

  /**
   * The distinction the whole file exists for: a cluster nobody could read has
   * refused nothing, and reporting it as a failure teaches an author to doubt a
   * manifest that is fine.
   */
  it('does not turn an unreadable cluster into a rejected manifest', () => {
    const checks = checksFor(facts({ clusterReady: null }));
    expect(byId(checks, 'cluster').status).toBe('unknown');
    expect(wouldDeploy(checks)).toBe(true);
  });

  it('says the repository has to be connected, and where to connect it', () => {
    const checks = checksFor(facts({ repositoryConnected: false }));
    const repo = byId(checks, 'repository');
    expect(repo.status).toBe('fail');
    expect(repo.detail).toContain('flui repo connect');
  });

  it('names both halves of the build credential when both are missing', () => {
    const checks = checksFor(
      facts({ githubConnected: false, registryCredential: false }),
    );
    const registry = byId(checks, 'registry');
    expect(registry.status).toBe('fail');
    expect(registry.detail).toContain('GitHub connection');
    expect(registry.detail).toContain('registry credential');
  });

  it('reports what was asked for and what is free when it does not fit', () => {
    const checks = checksFor(
      facts({
        capacity: {
          fits: false,
          requiredCpuMc: 2000,
          requiredMemoryMi: 4096,
          availableCpuMc: 500,
          availableMemoryMi: 900,
        },
      }),
    );
    const capacity = byId(checks, 'capacity');
    expect(capacity.status).toBe('fail');
    expect(capacity.detail).toContain('2000m CPU');
    expect(capacity.detail).toContain('500m CPU');
  });

  it('leaves capacity unanswered rather than refusing when it could not be read', () => {
    const checks = checksFor(facts({ capacity: null }));
    expect(byId(checks, 'capacity').status).toBe('unknown');
    expect(wouldDeploy(checks)).toBe(true);
  });

  it('warns that a reused identity updates instead of creating', () => {
    const checks = checksFor(facts({ existingApp: 'api-7f3a2c' }));
    const identity = byId(checks, 'identity');
    expect(identity.status).toBe('warn');
    expect(identity.detail).toContain('api-7f3a2c');
    // A warning is not a refusal: updating an application is the intended path.
    expect(wouldDeploy(checks)).toBe(true);
  });

  it('warns that a public app without a zone answers on the default host', () => {
    const checks = checksFor(facts({ dnsZone: null }));
    expect(byId(checks, 'exposure').status).toBe('warn');
  });

  it('warns that an explicit hostname needs a record nobody here will create', () => {
    const checks = checksFor(facts({ dnsZone: null, fqdn: 'app.example.com' }));
    const exposure = byId(checks, 'exposure');
    expect(exposure.status).toBe('warn');
    expect(exposure.detail).toContain('app.example.com');
  });

  it('asks nothing of an internal application it cannot answer', () => {
    const checks = checksFor(facts({ exposure: 'internal', dnsZone: null }));
    expect(byId(checks, 'exposure').status).toBe('pass');
  });

  /**
   * The shape most installations start on: one machine, one cluster. Refusing
   * it would leave the product with nowhere to deploy.
   */
  it('allows the control cluster, and says what is being given up', () => {
    const checks = checksFor(
      facts({ targetIsControlCluster: true, hasWorkloadCluster: null }),
    );
    const placement = byId(checks, 'placement');
    expect(placement.status).toBe('warn');
    expect(wouldDeploy(checks)).toBe(true);
    expect(placement.detail).toContain('single-machine');
  });

  it('says it differently when a workload cluster was there to be used', () => {
    const checks = checksFor(
      facts({ targetIsControlCluster: true, hasWorkloadCluster: true }),
    );
    const placement = byId(checks, 'placement');
    expect(placement.status).toBe('warn');
    expect(placement.detail).toContain('given up by choice');
  });

  it('says nothing at all when the target is a workload cluster', () => {
    expect(byId(checksFor(facts()), 'placement').status).toBe('pass');
  });
});
